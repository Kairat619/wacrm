import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createR2Storage, r2ConfigFromEnv, StorageError } from './r2-storage';

const CONFIG = {
  accountId: 'cf-account',
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  bucket: 'media',
};

let dir: string;
let requests: Request[];

function stubFetch(response: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return response();
    })
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2-'));
  requests = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('r2ConfigFromEnv', () => {
  it('needs every setting', () => {
    const env = {
      R2_ACCOUNT_ID: 'a',
      R2_ACCESS_KEY_ID: 'b',
      R2_SECRET_ACCESS_KEY: 'c',
      R2_BUCKET: 'd',
    };
    expect(r2ConfigFromEnv(env)).toEqual({
      accountId: 'a',
      accessKeyId: 'b',
      secretAccessKey: 'c',
      bucket: 'd',
    });
    expect(r2ConfigFromEnv({ ...env, R2_BUCKET: undefined })).toBeNull();
  });
});

describe('createR2Storage', () => {
  const key = 'account-1/inbound/555';

  it('uploads a signed PUT to the account endpoint', async () => {
    const file = join(dir, 'f');
    writeFileSync(file, 'abc');
    stubFetch(() => new Response(null, { status: 200 }));

    await createR2Storage(CONFIG).put(key, file, { contentType: 'image/png' });

    const request = requests[0];
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(
      'https://cf-account.r2.cloudflarestorage.com/media/account-1/inbound/555'
    );
    expect(request.headers.get('content-type')).toBe('image/png');
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(await request.text()).toBe('abc');
  });

  it('raises a failed upload without putting the URL in the message', async () => {
    const file = join(dir, 'f');
    writeFileSync(file, 'abc');
    stubFetch(() => new Response('denied', { status: 403 }));

    const error = await createR2Storage(CONFIG)
      .put(key, file, { contentType: 'image/png' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(StorageError);
    expect(error.httpStatus).toBe(403);
    expect(error.message).not.toContain('cloudflarestorage');
  });

  it('makes only one request per upload, leaving retries to the job', async () => {
    const file = join(dir, 'f');
    writeFileSync(file, 'abc');
    stubFetch(() => new Response('oops', { status: 503 }));

    await createR2Storage(CONFIG)
      .put(key, file, { contentType: 'image/png' })
      .catch(() => {});

    expect(requests).toHaveLength(1);
  });

  it('returns the object body and type', async () => {
    stubFetch(() => new Response('bytes', { headers: { 'content-type': 'image/png' } }));

    const object = await createR2Storage(CONFIG).get(key);

    expect(object?.contentType).toBe('image/png');
    expect(await new Response(object!.body).text()).toBe('bytes');
  });

  it('returns null for a missing object', async () => {
    stubFetch(() => new Response('', { status: 404 }));

    await expect(createR2Storage(CONFIG).get(key)).resolves.toBeNull();
  });

  it('raises on other read failures', async () => {
    stubFetch(() => new Response('', { status: 500 }));

    await expect(createR2Storage(CONFIG).get(key)).rejects.toBeInstanceOf(StorageError);
  });
});
