import { openAsBlob } from 'node:fs';

import { AwsClient } from 'aws4fetch';

/** What the media jobs need from object storage. Narrow so tests can fake it. */
export interface MediaStorage {
  put(
    key: string,
    filePath: string,
    options: { contentType: string }
  ): Promise<void>;
  /** Returns null when the object does not exist. */
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null } | null>;
}

export class StorageError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'StorageError';
    this.httpStatus = httpStatus;
  }
}

const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 30_000;

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Null when any R2 setting is missing. */
export function r2ConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

/**
 * Cloudflare R2 through its S3-compatible API. The bucket stays private: objects
 * are only ever read by the server, through the authenticated media route.
 */
export function createR2Storage(config: R2Config): MediaStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
    // The job runner owns retries, so failures stay visible and bounded.
    retries: 0,
  });
  const urlFor = (key: string) =>
    `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;

  return {
    async put(key, filePath, { contentType }) {
      const response = await client.fetch(urlFor(key), {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        // A file-backed blob sends the length without loading the file into memory.
        body: await openAsBlob(filePath),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        // The URL is left out of the message on purpose.
        throw new StorageError(`R2 upload failed: ${response.status}`, response.status);
      }
    },

    async get(key) {
      const response = await client.fetch(urlFor(key), {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok || !response.body) {
        throw new StorageError(`R2 read failed: ${response.status}`, response.status);
      }
      return {
        body: response.body,
        contentType: response.headers.get('content-type'),
      };
    },
  };
}

let cached: MediaStorage | null | undefined;

/** Shared instance, or null when R2 isn't configured. */
export function mediaStorageFromEnv(): MediaStorage | null {
  if (cached === undefined) {
    const config = r2ConfigFromEnv();
    cached = config ? createR2Storage(config) : null;
  }
  return cached;
}
