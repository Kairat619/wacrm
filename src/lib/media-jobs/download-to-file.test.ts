import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { downloadToFile, MediaTooLargeError } from './download-to-file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'download-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const args = (maxBytes = 1000) => ({
  downloadUrl: 'https://cdn.test/file',
  accessToken: 'token',
  destPath: join(dir, 'file'),
  maxBytes,
});

describe('downloadToFile', () => {
  it('writes the file and reports its size and hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { headers: { 'content-type': 'text/plain' } }))
    );

    await expect(downloadToFile(args())).resolves.toEqual({
      byteSize: 5,
      sha256: createHash('sha256').update('hello').digest('hex'),
      contentType: 'text/plain',
    });
    expect(readFileSync(join(dir, 'file'), 'utf8')).toBe('hello');
  });

  it('stops at the size limit and leaves nothing behind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(50))));

    await expect(downloadToFile(args(10))).rejects.toBeInstanceOf(MediaTooLargeError);

    expect(existsSync(join(dir, 'file'))).toBe(false);
    expect(existsSync(join(dir, 'file.partial'))).toBe(false);
  });

  it('surfaces a 429 with its Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '9' } }))
    );

    const error = await downloadToFile(args()).catch((e) => e);

    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.retryAfterSeconds).toBe(9);
    expect(existsSync(join(dir, 'file'))).toBe(false);
  });
});
