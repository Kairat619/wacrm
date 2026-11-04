import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { average, buildReliabilityReport, rate } from './metrics';

/** Every count query resolves to the same canned result; rows come per table. */
function fakeDb(options: {
  count?: number;
  failingTables?: string[];
  rows?: Record<string, unknown[]>;
}): SupabaseClient {
  return {
    from(table: string) {
      const failing = options.failingTables?.includes(table);
      const chain: Record<string, unknown> = {};
      let head = false;
      for (const method of ['eq', 'neq', 'in', 'gte', 'like', 'order', 'limit']) {
        chain[method] = () => chain;
      }
      chain.select = (_columns: string, opts?: { head?: boolean }) => {
        head = !!opts?.head;
        return chain;
      };
      chain.then = (resolve: (value: unknown) => void) =>
        resolve(
          failing
            ? { count: null, data: null, error: { message: 'relation does not exist' } }
            : head
              ? { count: options.count ?? 0, error: null }
              : { data: options.rows?.[table] ?? [], error: null }
        );
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('rate', () => {
  it('rounds to four decimal places', () => {
    expect(rate(1, 3)).toBe(0.3333);
  });

  it('is null, not zero, when there was no traffic', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(null, 5)).toBeNull();
  });
});

describe('average', () => {
  it('is null for no samples', () => {
    expect(average([])).toBeNull();
    expect(average([10, 20])).toBe(15);
  });
});

describe('buildReliabilityReport', () => {
  it('derives rates and latency from the stored rows', async () => {
    const report = await buildReliabilityReport(
      fakeDb({
        count: 4,
        rows: {
          media_jobs: [
            { download_ms: 100, rate_limit_hits: 1 },
            { download_ms: 300, rate_limit_hits: 2 },
            { download_ms: null, rate_limit_hits: 0 },
          ],
          webhook_events: [
            { created_at: '2026-01-01T00:00:00Z', processed_at: '2026-01-01T00:00:02Z' },
          ],
        },
      }),
      24
    );

    expect(report.window_hours).toBe(24);
    expect(report.media.avg_download_ms).toBe(200);
    expect(report.media.rate_limit_hits).toBe(3);
    expect(report.media.success_rate).toBe(0.3333);
    expect(report.outbound.success_rate).toBe(0.5);
    expect(report.outbound.error_131049).toBe(4);
    expect(report.webhook.avg_processing_ms).toBe(2000);
    expect(report.queue_backlog.media_jobs).toBe(4);
  });

  it('reports null for a table that is not there yet, and keeps the rest', async () => {
    const report = await buildReliabilityReport(
      fakeDb({ count: 2, failingTables: ['media_jobs', 'webhook_events'] }),
      24
    );

    expect(report.media.stored).toBeNull();
    expect(report.media.avg_download_ms).toBeNull();
    expect(report.webhook.avg_processing_ms).toBeNull();
    expect(report.outbound.sent_or_better).toBe(2);
  });
});
