import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Reliability figures derived from the job and message tables, so they need no
 * metrics service and cover restarts. HTTP 429s and latency come from columns the
 * jobs record. Auth refresh failures happen outside the database, so count those
 * from the `auth.refresh_failed` log event.
 *
 * A figure is null when it couldn't be read (say, its migration isn't applied),
 * so one missing table doesn't take down the whole report.
 */

export interface ReliabilityReport {
  window_hours: number;
  media: {
    stored: number | null;
    unavailable: number | null;
    failed: number | null;
    success_rate: number | null;
    unavailable_rate: number | null;
    avg_download_ms: number | null;
    rate_limit_hits: number | null;
    /** Jobs that hit a storage error at least once and haven't recovered. */
    r2_upload_failures: number | null;
  };
  outbound: {
    sent_or_better: number | null;
    failed: number | null;
    success_rate: number | null;
    error_131049: number | null;
    error_131000: number | null;
    delivery_unknown: number | null;
  };
  webhook: {
    avg_processing_ms: number | null;
    failed: number | null;
  };
  queue_backlog: {
    media_jobs: number | null;
    webhook_events: number | null;
    outbound_retries: number | null;
  };
}

/** Null when there's nothing to divide by; a 0% with no traffic would mislead. */
export function rate(part: number | null, total: number | null): number | null {
  if (part === null || total === null || total === 0) return null;
  return Math.round((part / total) * 10_000) / 10_000;
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function sumOf(part: number | null, other: number | null): number | null {
  return part === null || other === null ? null : part + other;
}

const SAMPLE_SIZE = 1000;

export async function buildReliabilityReport(
  db: SupabaseClient,
  windowHours: number,
  now: number = Date.now()
): Promise<ReliabilityReport> {
  const since = new Date(now - windowHours * 3_600_000).toISOString();

  const count = async (
    table: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the filter chain varies per call; supabase-js's generic type for it is too deep to name
    filter: (query: any) => PromiseLike<{ count: number | null; error: unknown }>
  ): Promise<number | null> => {
    const { count: total, error } = await filter(
      db.from(table).select('id', { count: 'exact', head: true })
    );
    return error ? null : (total ?? 0);
  };

  const media = (status: string) =>
    count('media_jobs', (q) => q.eq('status', status).gte('finished_at', since));
  const outbound = (statuses: string[]) =>
    count('messages', (q) =>
      q.in('status', statuses).neq('sender_type', 'customer').gte('created_at', since)
    );
  const outboundCode = (code: number) =>
    count('messages', (q) => q.eq('error_code', code).gte('created_at', since));

  const [
    stored,
    unavailable,
    mediaFailed,
    sent,
    outboundFailed,
    code131049,
    code131000,
    deliveryUnknown,
    r2Failures,
    webhookFailed,
    mediaBacklog,
    webhookBacklog,
    outboundBacklog,
    timedJobs,
    processedEvents,
  ] = await Promise.all([
    media('stored'),
    media('unavailable'),
    media('failed'),
    outbound(['sent', 'delivered', 'read']),
    outbound(['failed']),
    outboundCode(131049),
    outboundCode(131000),
    count('messages', (q) => q.eq('retry_class', 'delivery_unknown').gte('created_at', since)),
    count('media_jobs', (q) =>
      q
        .like('last_error', 'R2 upload failed%')
        .in('status', ['retrying', 'failed'])
        .gte('created_at', since)
    ),
    count('webhook_events', (q) => q.eq('status', 'failed').gte('created_at', since)),
    count('media_jobs', (q) => q.in('status', ['pending', 'retrying', 'downloading'])),
    count('webhook_events', (q) => q.in('status', ['pending', 'processing'])),
    count('messages', (q) => q.eq('status', 'queued')),
    db
      .from('media_jobs')
      .select('download_ms, rate_limit_hits')
      .gte('created_at', since)
      .limit(SAMPLE_SIZE),
    db
      .from('webhook_events')
      .select('created_at, processed_at')
      .eq('status', 'done')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(SAMPLE_SIZE),
  ]);

  const jobs = timedJobs.error
    ? null
    : ((timedJobs.data ?? []) as { download_ms: number | null; rate_limit_hits: number }[]);
  const events = processedEvents.error
    ? null
    : ((processedEvents.data ?? []) as { created_at: string; processed_at: string | null }[]);

  const finished = sumOf(sumOf(stored, unavailable), mediaFailed);

  return {
    window_hours: windowHours,
    media: {
      stored,
      unavailable,
      failed: mediaFailed,
      success_rate: rate(stored, finished),
      unavailable_rate: rate(unavailable, finished),
      avg_download_ms: jobs
        ? average(jobs.flatMap((job) => (job.download_ms === null ? [] : [job.download_ms])))
        : null,
      rate_limit_hits: jobs ? jobs.reduce((sum, job) => sum + job.rate_limit_hits, 0) : null,
      r2_upload_failures: r2Failures,
    },
    outbound: {
      sent_or_better: sent,
      failed: outboundFailed,
      success_rate: rate(sent, sumOf(sent, outboundFailed)),
      error_131049: code131049,
      error_131000: code131000,
      delivery_unknown: deliveryUnknown,
    },
    webhook: {
      avg_processing_ms: events
        ? average(
            events.flatMap((event) =>
              event.processed_at
                ? [Date.parse(event.processed_at) - Date.parse(event.created_at)]
                : []
            )
          )
        : null,
      failed: webhookFailed,
    },
    queue_backlog: {
      media_jobs: mediaBacklog,
      webhook_events: webhookBacklog,
      outbound_retries: outboundBacklog,
    },
  };
}
