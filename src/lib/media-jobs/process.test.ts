import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { MediaTooLargeError } from './download-to-file';
import {
  classifyMediaFailure,
  mediaStorageKey,
  processMediaJob,
  type MediaJobDeps,
} from './process';
import type { MediaJobRow } from './queue';
import { StorageError } from './r2-storage';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const WORKER = 'worker-1';

let stageDir: string;
let updates: { table: string; patch: Record<string, unknown>; filters: unknown[][] }[];

/** Records writes; every chained filter call resolves as a successful update. */
function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          const entry = { table, patch, filters: [] as unknown[][] };
          updates.push(entry);
          const chain = {
            eq: (...args: unknown[]) => (entry.filters.push(['eq', ...args]), chain),
            in: (...args: unknown[]) => (entry.filters.push(['in', ...args]), chain),
            lt: (...args: unknown[]) => (entry.filters.push(['lt', ...args]), chain),
            is: (...args: unknown[]) => (entry.filters.push(['is', ...args]), chain),
            then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
}

function job(overrides: Partial<MediaJobRow> = {}): MediaJobRow {
  return {
    id: 'job-1',
    account_id: 'acc-1',
    message_row_id: 'msg-1',
    media_id: '555',
    mime_type: 'image/jpeg',
    file_name: null,
    status: 'downloading',
    attempts: 1,
    max_attempts: 8,
    storage_key: null,
    content_type: null,
    byte_size: null,
    sha256: null,
    rate_limit_hits: 0,
    created_at: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function deps(overrides: Partial<MediaJobDeps> = {}) {
  const put = vi.fn(async () => {});
  const getMediaUrl = vi.fn(async () => ({
    url: 'https://cdn.test/file',
    mimeType: 'image/jpeg',
    fileSize: 3,
    sha256: null as string | null,
  }));
  const downloadToFile = vi.fn(async ({ destPath }: { destPath: string }) => {
    writeFileSync(destPath, 'abc');
    return { byteSize: 3, sha256: 'hash-of-abc', contentType: 'image/jpeg' };
  });
  return {
    put,
    getMediaUrl,
    downloadToFile,
    value: {
      db: fakeDb(),
      storage: { put, get: vi.fn() },
      worker: WORKER,
      stageDir,
      loadAccessToken: async () => 'token',
      getMediaUrl,
      downloadToFile,
      now: () => NOW,
      random: () => 0,
      ...overrides,
    } as MediaJobDeps,
  };
}

const jobUpdates = () => updates.filter((u) => u.table === 'media_jobs');
const lastJobPatch = () => jobUpdates().at(-1)!.patch;

beforeEach(() => {
  stageDir = mkdtempSync(join(tmpdir(), 'media-job-'));
  updates = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(stageDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('classifyMediaFailure', () => {
  const meta = (fields: ConstructorParameters<typeof MetaApiError>[1], message = 'x') =>
    new MetaApiError(message, fields);

  it.each([
    ['429 on lookup', meta({ httpStatus: 429 }), 'lookup', 'rate_limited'],
    ['429 on CDN', meta({ httpStatus: 429 }), 'download', 'rate_limited'],
    ['throttling code', meta({ code: 130429, httpStatus: 400 }), 'lookup', 'rate_limited'],
    ['expired media id', meta({ code: 100, subcode: 33, httpStatus: 400 }), 'lookup', 'unavailable'],
    ['bad token', meta({ code: 190, httpStatus: 401 }), 'lookup', 'auth'],
    ['stale CDN link 403', meta({ httpStatus: 403 }), 'download', 'url_expired'],
    ['stale CDN link 404', meta({ httpStatus: 404 }), 'download', 'url_expired'],
    ['CDN 500', meta({ httpStatus: 500 }), 'download', 'transient'],
    ['Graph 500', meta({ httpStatus: 500 }), 'lookup', 'transient'],
    ['unrelated code 100', meta({ code: 100, httpStatus: 400 }, 'Invalid parameter'), 'lookup', 'transient'],
    ['network error', new TypeError('fetch failed'), 'download', 'transient'],
    ['R2 error', new StorageError('R2 upload failed: 500', 500), 'upload', 'transient'],
    ['too large', new MediaTooLargeError(10), 'download', 'permanent'],
  ] as const)('%s', (_name, error, stage, expected) => {
    expect(classifyMediaFailure(error, stage)).toBe(expected);
  });
});

describe('processMediaJob', () => {
  it('stores the file and records the result', async () => {
    const d = deps();

    await expect(processMediaJob(job(), d.value)).resolves.toBe('stored');

    expect(d.put).toHaveBeenCalledWith(
      mediaStorageKey('acc-1', '555'),
      join(stageDir, 'job-1'),
      { contentType: 'image/jpeg' }
    );
    expect(lastJobPatch()).toMatchObject({
      status: 'stored',
      storage_key: 'account-acc-1/inbound/555',
      locked_by: null,
    });
    expect(existsSync(join(stageDir, 'job-1'))).toBe(false);
  });

  it('fills in the URL only on a message that has none', async () => {
    await processMediaJob(job(), deps().value);

    const message = updates.find((u) => u.table === 'messages')!;
    expect(message.patch).toEqual({ media_url: '/api/whatsapp/media/555' });
    expect(message.filters).toContainEqual(['is', 'media_url', null]);
  });

  it('only writes while this worker still holds the job', async () => {
    await processMediaJob(job(), deps().value);

    for (const update of jobUpdates()) {
      expect(update.filters).toContainEqual(['eq', 'locked_by', WORKER]);
    }
  });

  describe('HTTP 429 and Retry-After', () => {
    const throttled = () =>
      new MetaApiError('slow down', { httpStatus: 429, retryAfterSeconds: 120 });

    it('waits at least as long as Retry-After says', async () => {
      const d = deps();
      d.downloadToFile.mockRejectedValueOnce(throttled());

      await expect(processMediaJob(job(), d.value)).resolves.toBe('retrying');

      expect(lastPatchWithStatus('retrying').next_attempt_at).toBe(
        new Date(NOW + 120_000).toISOString()
      );
    });

    it('does not use up an attempt, and counts the hit', async () => {
      const d = deps();
      d.downloadToFile.mockRejectedValueOnce(throttled());

      await processMediaJob(job({ attempts: 3, rate_limit_hits: 1 }), d.value);

      expect(lastPatchWithStatus('retrying')).toMatchObject({
        attempts: 2,
        rate_limit_hits: 2,
        last_http_status: 429,
      });
    });

    it("holds back the account's other queued jobs too", async () => {
      const d = deps();
      d.downloadToFile.mockRejectedValueOnce(throttled());

      await processMediaJob(job(), d.value);

      const hold = jobUpdates().at(-1)!;
      expect(hold.patch).toEqual({ next_attempt_at: new Date(NOW + 120_000).toISOString() });
      expect(hold.filters).toContainEqual(['eq', 'account_id', 'acc-1']);
    });

    it('gives up once past the retention window rather than retrying forever', async () => {
      const d = deps();
      d.downloadToFile.mockRejectedValueOnce(throttled());
      const old = new Date(NOW - 40 * 86_400_000).toISOString();

      await expect(processMediaJob(job({ created_at: old }), d.value)).resolves.toBe('unavailable');
    });
  });

  it('marks an expired media id unavailable, with no retry or download', async () => {
    const d = deps();
    d.getMediaUrl.mockRejectedValueOnce(
      new MetaApiError('Unsupported get request', { code: 100, subcode: 33, httpStatus: 400 })
    );

    await expect(processMediaJob(job(), d.value)).resolves.toBe('unavailable');

    expect(d.downloadToFile).not.toHaveBeenCalled();
    expect(lastJobPatch()).toMatchObject({ status: 'unavailable', locked_by: null });
    expect(lastJobPatch().next_attempt_at).toBeUndefined();
  });

  describe('temporary URL expiry', () => {
    it('gets a fresh URL once and succeeds', async () => {
      const d = deps();
      d.downloadToFile.mockRejectedValueOnce(new MetaApiError('expired', { httpStatus: 403 }));

      await expect(processMediaJob(job(), d.value)).resolves.toBe('stored');

      expect(d.getMediaUrl).toHaveBeenCalledTimes(2);
      expect(d.downloadToFile).toHaveBeenCalledTimes(2);
    });

    it('schedules a retry when the fresh URL fails too, rather than looping', async () => {
      const d = deps();
      d.downloadToFile.mockRejectedValue(new MetaApiError('expired', { httpStatus: 403 }));

      await expect(processMediaJob(job(), d.value)).resolves.toBe('retrying');

      expect(d.getMediaUrl).toHaveBeenCalledTimes(2);
    });
  });

  describe('R2 upload failure', () => {
    it('retries without losing the downloaded file', async () => {
      const d = deps();
      d.put.mockRejectedValueOnce(new StorageError('R2 upload failed: 500', 500));

      await expect(processMediaJob(job(), d.value)).resolves.toBe('retrying');

      expect(existsSync(join(stageDir, 'job-1'))).toBe(true);
      expect(lastPatchWithStatus('retrying')).toMatchObject({ last_http_status: 500 });
    });

    it('uploads on the next attempt without downloading again', async () => {
      writeFileSync(join(stageDir, 'job-1'), 'abc');
      const d = deps();

      await expect(
        processMediaJob(
          job({ attempts: 2, byte_size: 3, sha256: 'h', content_type: 'image/jpeg' }),
          d.value
        )
      ).resolves.toBe('stored');

      expect(d.downloadToFile).not.toHaveBeenCalled();
      expect(d.getMediaUrl).not.toHaveBeenCalled();
      expect(d.put).toHaveBeenCalledTimes(1);
    });

    it('downloads again when the saved file is gone, such as after a restart', async () => {
      const d = deps();

      await processMediaJob(
        job({ attempts: 2, byte_size: 3, sha256: 'h', content_type: 'image/jpeg' }),
        d.value
      );

      expect(d.downloadToFile).toHaveBeenCalledTimes(1);
    });

    it('downloads again when the saved file is incomplete', async () => {
      writeFileSync(join(stageDir, 'job-1'), 'a');
      const d = deps();

      await processMediaJob(
        job({ attempts: 2, byte_size: 3, sha256: 'h', content_type: 'image/jpeg' }),
        d.value
      );

      expect(d.downloadToFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('checksum', () => {
    it('accepts a file matching what Meta reported', async () => {
      const d = deps();
      d.getMediaUrl.mockResolvedValueOnce({
        url: 'https://cdn.test/file',
        mimeType: 'image/jpeg',
        fileSize: 3,
        sha256: 'HASH-OF-ABC',
      });

      await expect(processMediaJob(job(), d.value)).resolves.toBe('stored');
    });

    it('rejects and discards a corrupt download, then retries', async () => {
      const d = deps();
      d.getMediaUrl.mockResolvedValueOnce({
        url: 'https://cdn.test/file',
        mimeType: 'image/jpeg',
        fileSize: 3,
        sha256: 'something-else',
      });

      await expect(processMediaJob(job(), d.value)).resolves.toBe('retrying');

      expect(d.put).not.toHaveBeenCalled();
      expect(existsSync(join(stageDir, 'job-1'))).toBe(false);
    });
  });

  it('fails permanently, with no retry, when the file is too large', async () => {
    const d = deps();
    d.getMediaUrl.mockResolvedValueOnce({
      url: 'https://cdn.test/file',
      mimeType: 'application/pdf',
      fileSize: 500 * 1024 * 1024,
      sha256: null,
    });

    await expect(processMediaJob(job(), d.value)).resolves.toBe('failed');

    expect(d.downloadToFile).not.toHaveBeenCalled();
  });

  it('stops retrying once attempts are used up', async () => {
    const d = deps();
    d.downloadToFile.mockRejectedValue(new TypeError('fetch failed'));

    await expect(processMediaJob(job({ attempts: 8 }), d.value)).resolves.toBe('failed');

    expect(lastJobPatch()).toMatchObject({ status: 'failed', locked_by: null });
  });

  it('backs off between ordinary retries', async () => {
    const d = deps({ random: () => 0.5 });
    d.downloadToFile.mockRejectedValue(new TypeError('fetch failed'));

    await processMediaJob(job({ attempts: 3 }), d.value);

    expect(lastJobPatch().next_attempt_at).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('pauses for an hour without using an attempt when the token is unusable', async () => {
    const d = deps({ loadAccessToken: async () => null });

    await expect(processMediaJob(job({ attempts: 2 }), d.value)).resolves.toBe('retrying');

    expect(d.getMediaUrl).not.toHaveBeenCalled();
    expect(lastJobPatch()).toMatchObject({
      attempts: 1,
      next_attempt_at: new Date(NOW + 3_600_000).toISOString(),
    });
  });

  it('never writes a token or CDN link to the logs', async () => {
    const d = deps();
    const signed = 'https://cdn.test/file?hash=SIGNED';
    d.downloadToFile.mockRejectedValueOnce(new TypeError(`failed fetching ${signed}`));
    const warn = vi.spyOn(console, 'warn');

    await processMediaJob(job(), d.value);

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SIGNED');
  });
});

function lastPatchWithStatus(status: string) {
  return jobUpdates()
    .filter((u) => u.patch.status === status)
    .at(-1)!.patch;
}
