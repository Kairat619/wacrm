import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logEvent } from '@/lib/observability/log';
import { backoffDelayMs } from '@/lib/reliability/backoff';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { MediaTooLargeError, type DownloadedFile } from './download-to-file';
import type { MediaJobRow } from './queue';
import { StorageError, type MediaStorage } from './r2-storage';

/** Meta's largest attachment, a document, per the code comments in this repo. */
export const MEDIA_JOB_MAX_BYTES = 100 * 1024 * 1024;
/** Meta keeps media about 30 days, so a job older than this has no hope left. */
const RETRY_WINDOW_MS = 35 * 86_400_000;
const AUTH_PAUSE_MS = 60 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;

export class ChecksumMismatchError extends Error {
  constructor() {
    super('downloaded media did not match the checksum Meta reported');
    this.name = 'ChecksumMismatchError';
  }
}

export type FailureClass =
  /** Meta asked us to slow down; doesn't use up an attempt. */
  | 'rate_limited'
  /** The WhatsApp token is broken; retrying before it's fixed can't help. */
  | 'auth'
  /** Meta no longer holds the media. Never retried. */
  | 'unavailable'
  /** The temporary CDN link stopped working; get a fresh one. */
  | 'url_expired'
  /** Can never succeed. Never retried. */
  | 'permanent'
  /** Anything else: worth another bounded try. */
  | 'transient';

export type MediaStage = 'lookup' | 'download' | 'upload';

/** Pure, so every branch can be tested directly. */
export function classifyMediaFailure(error: unknown, stage: MediaStage): FailureClass {
  if (error instanceof MediaTooLargeError) return 'permanent';
  if (error instanceof MetaApiError) {
    if (error.isRateLimited) return 'rate_limited';
    if (error.code === 190) return 'auth';
    if (stage === 'lookup') {
      if (error.isMissingObject) return 'unavailable';
      if (error.httpStatus === 401) return 'auth';
    }
    // On the CDN these mean the link went stale, not that the media is gone.
    // Only the Graph lookup can say that, and it just gets asked again.
    if (stage === 'download' && [401, 403, 404, 410].includes(error.httpStatus)) {
      return 'url_expired';
    }
  }
  return 'transient';
}

export interface MediaJobDeps {
  db: SupabaseClient;
  storage: MediaStorage;
  worker: string;
  /** Local folder holding downloads between a download and its upload. */
  stageDir: string;
  /** Null when the account's token is missing or can't be decrypted. */
  loadAccessToken(accountId: string): Promise<string | null>;
  getMediaUrl(args: {
    mediaId: string;
    accessToken: string;
  }): Promise<{ url: string; mimeType: string; fileSize: number | null; sha256: string | null }>;
  downloadToFile(args: {
    downloadUrl: string;
    accessToken: string;
    destPath: string;
    maxBytes: number;
  }): Promise<DownloadedFile>;
  now?: () => number;
  random?: () => number;
}

export type MediaJobOutcome = 'stored' | 'retrying' | 'unavailable' | 'failed';

/** Object key. Stable per media id, so re-uploading overwrites one object. */
export function mediaStorageKey(accountId: string, mediaId: string): string {
  return `account-${accountId}/inbound/${mediaId}`;
}

/** Records the failure details common to every failed attempt. */
function failureFields(error: unknown) {
  if (error instanceof MetaApiError) {
    return {
      last_error: error.message,
      last_http_status: error.httpStatus,
      last_error_code: error.code,
    };
  }
  if (error instanceof StorageError) {
    return {
      last_error: error.message,
      last_http_status: error.httpStatus,
      last_error_code: null,
    };
  }
  return {
    last_error: error instanceof Error ? error.message : String(error),
    last_http_status: null,
    last_error_code: null,
  };
}

/**
 * Update only while this worker still holds the job. If its lease expired and
 * another worker took over, this write is dropped rather than overwriting it.
 */
async function updateJob(
  deps: MediaJobDeps,
  job: MediaJobRow,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await deps.db
    .from('media_jobs')
    .update({ ...patch, updated_at: new Date((deps.now ?? Date.now)()).toISOString() })
    .eq('id', job.id)
    .eq('locked_by', deps.worker);
  if (error) throw new Error(`updating media job failed: ${error.message}`);
}

async function isStaged(path: string, byteSize: number | null): Promise<boolean> {
  if (byteSize === null) return false;
  try {
    return (await stat(path)).size === byteSize;
  } catch {
    return false;
  }
}

/**
 * Fetch the file from Meta. The CDN link is resolved fresh for each attempt, and
 * re-resolved once more if it goes stale mid-attempt.
 */
async function download(
  deps: MediaJobDeps,
  job: MediaJobRow,
  accessToken: string,
  destPath: string
): Promise<DownloadedFile> {
  for (let refreshed = false; ; refreshed = true) {
    let stage: MediaStage = 'lookup';
    try {
      const info = await deps.getMediaUrl({ mediaId: job.media_id, accessToken });
      if (info.fileSize !== null && info.fileSize > MEDIA_JOB_MAX_BYTES) {
        throw new MediaTooLargeError(MEDIA_JOB_MAX_BYTES);
      }
      stage = 'download';
      const file = await deps.downloadToFile({
        downloadUrl: info.url,
        accessToken,
        destPath,
        maxBytes: MEDIA_JOB_MAX_BYTES,
      });
      if (info.sha256 && info.sha256.toLowerCase() !== file.sha256) {
        await rm(destPath, { force: true });
        throw new ChecksumMismatchError();
      }
      return {
        ...file,
        contentType: info.mimeType || file.contentType,
      };
    } catch (error) {
      if (!refreshed && classifyMediaFailure(error, stage) === 'url_expired') continue;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        mediaStage: stage,
      });
    }
  }
}

/**
 * Run one claimed job to its next state. Doesn't throw for an expected failure:
 * every failure ends in a recorded state and, where it applies, a scheduled retry.
 */
export async function processMediaJob(
  job: MediaJobRow,
  deps: MediaJobDeps
): Promise<MediaJobOutcome> {
  const now = deps.now ?? Date.now;
  const stagedPath = join(deps.stageDir, job.id);
  const startedAt = now();
  let stage: MediaStage = 'lookup';
  const finishedAt = () => new Date(now()).toISOString();

  try {
    // A previous attempt may have downloaded this already and failed only at
    // the upload. In that case the file doesn't need fetching a second time.
    let byteSize = job.byte_size;
    let contentType = job.content_type;
    let sha256 = job.sha256;
    if (!(await isStaged(stagedPath, byteSize))) {
      const accessToken = await deps.loadAccessToken(job.account_id);
      if (!accessToken) {
        throw new MetaApiError('WhatsApp access token unavailable', {
          code: 190,
          httpStatus: 401,
        });
      }
      stage = 'download';
      const file = await download(deps, job, accessToken, stagedPath);
      byteSize = file.byteSize;
      sha256 = file.sha256;
      contentType = file.contentType ?? job.mime_type;
      await updateJob(deps, job, {
        byte_size: byteSize,
        sha256,
        content_type: contentType,
        download_ms: now() - startedAt,
      });
    }

    stage = 'upload';
    const key = mediaStorageKey(job.account_id, job.media_id);
    await deps.storage.put(key, stagedPath, {
      contentType: contentType ?? 'application/octet-stream',
    });

    await updateJob(deps, job, {
      status: 'stored',
      storage_key: key,
      locked_by: null,
      locked_until: null,
      last_error: null,
      last_http_status: null,
      last_error_code: null,
      finished_at: finishedAt(),
    });
    // A message whose lookup failed before jobs existed has no URL at all.
    await deps.db
      .from('messages')
      .update({ media_url: `/api/whatsapp/media/${job.media_id}` })
      .eq('id', job.message_row_id)
      .is('media_url', null);
    await rm(stagedPath, { force: true });

    logEvent('info', 'media.stored', {
      job_id: job.id,
      attempts: job.attempts,
      byte_size: byteSize,
      total_ms: now() - startedAt,
    });
    return 'stored';
  } catch (error) {
    const failedStage =
      (error as { mediaStage?: MediaStage }).mediaStage ?? (stage === 'download' ? 'lookup' : stage);
    return recordFailure(job, deps, error, failedStage, stagedPath);
  }
}

async function recordFailure(
  job: MediaJobRow,
  deps: MediaJobDeps,
  error: unknown,
  stage: MediaStage,
  stagedPath: string
): Promise<MediaJobOutcome> {
  const now = deps.now ?? Date.now;
  const finishedAt = new Date(now()).toISOString();
  const failure = classifyMediaFailure(error, stage);
  const fields = failureFields(error);
  const logFields = {
    job_id: job.id,
    stage,
    attempts: job.attempts,
    failure,
    http_status: fields.last_http_status,
    code: fields.last_error_code,
    error: fields.last_error,
  };

  const terminal = async (status: 'unavailable' | 'failed') => {
    await updateJob(deps, job, {
      ...fields,
      status,
      locked_by: null,
      locked_until: null,
      finished_at: finishedAt,
    });
    await rm(stagedPath, { force: true });
    logEvent(status === 'failed' ? 'error' : 'warn', `media.${status}`, logFields);
    return status;
  };

  if (failure === 'unavailable') return terminal('unavailable');
  if (failure === 'permanent') return terminal('failed');

  // Rate limits and a broken token aren't this file's fault, so they don't use
  // up attempts. They still can't run forever: past Meta's retention window
  // there is nothing left to fetch.
  const refundAttempt = failure === 'rate_limited' || failure === 'auth';
  if (refundAttempt && now() - Date.parse(job.created_at) > RETRY_WINDOW_MS) {
    return terminal('unavailable');
  }
  if (!refundAttempt && job.attempts >= job.max_attempts) return terminal('failed');

  const retryAfterSeconds = error instanceof MetaApiError ? error.retryAfterSeconds : null;
  const rateLimitHits = job.rate_limit_hits + (failure === 'rate_limited' ? 1 : 0);
  const delay =
    failure === 'auth'
      ? AUTH_PAUSE_MS
      : backoffDelayMs(failure === 'rate_limited' ? rateLimitHits : job.attempts, {
          baseMs: RETRY_BASE_MS,
          maxMs: RETRY_MAX_MS,
          retryAfterSeconds,
          random: deps.random,
        });
  const nextAttemptAt = new Date(now() + delay).toISOString();

  await updateJob(deps, job, {
    ...fields,
    status: 'retrying',
    attempts: refundAttempt ? job.attempts - 1 : job.attempts,
    rate_limit_hits: rateLimitHits,
    next_attempt_at: nextAttemptAt,
    locked_by: null,
    locked_until: null,
  });

  // A rate limit applies to the whole account, so hold back its other queued
  // jobs too instead of letting them each run into the same wall.
  if (failure === 'rate_limited') {
    const { error: holdError } = await deps.db
      .from('media_jobs')
      .update({ next_attempt_at: nextAttemptAt })
      .eq('account_id', job.account_id)
      .in('status', ['pending', 'retrying'])
      .lt('next_attempt_at', nextAttemptAt);
    if (holdError) {
      logEvent('warn', 'media.hold_failed', { job_id: job.id, error: holdError.message });
    }
  }

  logEvent('warn', 'media.retry', { ...logFields, next_attempt_at: nextAttemptAt });
  return 'retrying';
}
