import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { downloadToFile } from '@/lib/media-jobs/download-to-file';
import { processMediaJob, type MediaJobDeps } from '@/lib/media-jobs/process';
import { claimMediaJobs, type MediaJobRow } from '@/lib/media-jobs/queue';
import {
  mediaStorageFromEnv,
  verifyMediaStorage,
  type MediaStorage,
} from '@/lib/media-jobs/r2-storage';
import { logEvent } from '@/lib/observability/log';
import {
  durableWebhookIntakeEnabled,
  mediaJobsEnabled,
  outboundPersistFirstEnabled,
} from '@/lib/reliability/flags';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getMediaUrl } from '@/lib/whatsapp/meta-api';
import { runOutboundRetries } from '@/lib/whatsapp/outbound-retry';
import { pruneWebhookEvents, recoverWebhookEvents } from '@/lib/whatsapp/webhook-events';
import { startWorker, type RecurringTask } from './run';

/**
 * Background worker: its own Railway service, so a large download can't take the
 * web process down with it. Everything it does lives in Postgres, so a restart
 * loses nothing. See docs/deployment-railway.md.
 */

const WORKER_ID = `worker-${randomUUID()}`;
const STAGE_DIR = join(tmpdir(), 'wacrm-media-stage');
/** Finishes inside the 30-second drain set on the Railway service. */
const SHUTDOWN_GRACE_MS = 25_000;
const STAGE_MAX_AGE_MS = 24 * 3_600_000;
/** Started by a sweep and still going; shutdown waits for these. */
const mediaInFlight = new Set<Promise<unknown>>();

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Downloads in progress at once. This is the media concurrency bound. */
const MEDIA_CONCURRENCY = positiveInt(process.env.MEDIA_WORKER_CONCURRENCY, 3);

async function loadAccessToken(accountId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('access_token')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`loading WhatsApp config failed: ${error.message}`);
  if (!data?.access_token) return null;
  try {
    return decrypt(data.access_token);
  } catch {
    return null;
  }
}

/**
 * The storage to use, or null if it isn't usable. In that case jobs stay queued,
 * untouched, rather than burning their retries on a settings problem, and files
 * keep being served from Meta. Changing a variable redeploys the worker, which
 * runs this check again.
 */
async function usableMediaStorage(): Promise<MediaStorage | null> {
  const storage = mediaStorageFromEnv();
  if (!storage) {
    logEvent('error', 'media.storage_check_failed', {
      reason: 'the R2_* settings are incomplete',
    });
    return null;
  }
  try {
    await verifyMediaStorage(storage, STAGE_DIR);
    logEvent('info', 'media.storage_check_passed', {});
    return storage;
  } catch (error) {
    logEvent('error', 'media.storage_check_failed', { error });
    return null;
  }
}

function mediaTask(storage: MediaStorage): RecurringTask {
  const deps: MediaJobDeps = {
    db: supabaseAdmin(),
    storage,
    worker: WORKER_ID,
    stageDir: STAGE_DIR,
    loadAccessToken,
    getMediaUrl,
    downloadToFile,
  };
  const running = mediaInFlight;

  const start = (job: MediaJobRow) => {
    const execution = processMediaJob(job, deps)
      .catch((error) => {
        // Only a database failure while recording the outcome gets here. The
        // job's lease will expire and it will be picked up again.
        logEvent('error', 'media.process_failed', { job_id: job.id, error });
      })
      .finally(() => running.delete(execution));
    running.add(execution);
  };

  return {
    name: 'media-jobs',
    intervalMs: 5_000,
    async run() {
      const free = MEDIA_CONCURRENCY - running.size;
      if (free <= 0) return;
      const jobs = await claimMediaJobs(deps.db, WORKER_ID, free);
      for (const job of jobs) start(job);
    },
  };
}

/** Clears files left behind when a job ended in a crash. */
async function cleanStageDir(now: number = Date.now()): Promise<void> {
  for (const name of await readdir(STAGE_DIR)) {
    const path = join(STAGE_DIR, name);
    const { mtimeMs } = await stat(path);
    if (now - mtimeMs > STAGE_MAX_AGE_MS) await rm(path, { force: true });
  }
}

async function main(): Promise<void> {
  await mkdir(STAGE_DIR, { recursive: true });
  const db = supabaseAdmin();
  const tasks: RecurringTask[] = [];

  if (durableWebhookIntakeEnabled()) {
    tasks.push(
      { name: 'webhook-recovery', intervalMs: 30_000, run: () => recoverWebhookEvents(db, 20) },
      { name: 'webhook-prune', intervalMs: 3_600_000, run: () => pruneWebhookEvents(db) }
    );
  }
  if (mediaJobsEnabled()) {
    const storage = await usableMediaStorage();
    if (storage) {
      tasks.push(mediaTask(storage), {
        name: 'stage-cleanup',
        intervalMs: 3_600_000,
        run: () => cleanStageDir(),
      });
    }
  }
  if (outboundPersistFirstEnabled()) {
    tasks.push({
      name: 'outbound-retries',
      intervalMs: 15_000,
      run: () => runOutboundRetries(db, 20),
    });
  }

  logEvent('info', 'worker.started', {
    worker: WORKER_ID,
    tasks: tasks.map((task) => task.name),
    media_concurrency: MEDIA_CONCURRENCY,
  });
  if (tasks.length === 0) {
    logEvent('warn', 'worker.idle', { reason: 'no reliability flags are enabled' });
  }

  const worker = startWorker(tasks);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('info', 'worker.stopping', { signal });
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    await worker.stop(SHUTDOWN_GRACE_MS);
    // Anything still going past the limit is recovered through its lease.
    await Promise.race([
      Promise.allSettled([...mediaInFlight]),
      new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
    ]);
    logEvent('info', 'worker.stopped', { signal });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // With no tasks scheduled, this stops Node exiting and Railway restart-looping.
  setInterval(() => {}, 3_600_000);
}

main().catch((error) => {
  logEvent('error', 'worker.start_failed', { error });
  process.exit(1);
});
