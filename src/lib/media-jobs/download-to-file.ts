import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { metaErrorFromResponse } from '@/lib/whatsapp/meta-api';

/** Generous because this streams to disk, unlike the proxy's in-memory read. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export class MediaTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`media exceeds the ${maxBytes}-byte limit`);
    this.name = 'MediaTooLargeError';
  }
}

export interface DownloadedFile {
  byteSize: number;
  sha256: string;
  contentType: string | null;
}

/**
 * Stream a media file to disk, enforcing the size limit while it arrives, since
 * Meta's reported size is only advisory. Writes through a temporary name so a
 * partial download can never be mistaken for a complete one.
 */
export async function downloadToFile(args: {
  downloadUrl: string;
  accessToken: string;
  destPath: string;
  maxBytes: number;
}): Promise<DownloadedFile> {
  const { downloadUrl, accessToken, destPath, maxBytes } = args;

  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await metaErrorFromResponse(
      response,
      `Media download failed: ${response.status}`
    );
  }
  if (!response.body) throw new Error('Media download returned no body');

  const hash = createHash('sha256');
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        callback(new MediaTooLargeError(maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  const partial = `${destPath}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      meter,
      createWriteStream(partial)
    );
    await rename(partial, destPath);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  return {
    byteSize,
    sha256: hash.digest('hex'),
    contentType: response.headers.get('content-type'),
  };
}
