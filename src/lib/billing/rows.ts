import type { PricingDataPoint } from '@/lib/whatsapp/meta-api';

/** One `whatsapp_billing_daily` row (migration 064). */
export interface BillingDailyRow {
  account_id: string;
  waba_id: string;
  day: string;
  pricing_category: string;
  pricing_type: string;
  country: string;
  volume: number;
  cost: number;
  currency: string | null;
  fetched_at: string;
}

function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function dim(value: string | undefined): string {
  return value && value.trim() ? value.trim().toUpperCase() : 'UNKNOWN';
}

/**
 * Turn Meta's data points into rows keyed by (day, category, type, country).
 * Meta buckets "daily" by the WABA's timezone, so a bucket can start a few
 * hours before UTC midnight; the row uses the UTC day of the bucket's
 * midpoint. Points sharing a key are summed.
 */
export function toBillingRows(
  points: readonly PricingDataPoint[],
  ctx: {
    accountId: string;
    wabaId: string;
    currency: string | null;
    fetchedAt: string;
  }
): BillingDailyRow[] {
  const byKey = new Map<string, BillingDailyRow>();
  for (const p of points) {
    const day = utcDay((p.start + p.end) / 2);
    const row: BillingDailyRow = {
      account_id: ctx.accountId,
      waba_id: ctx.wabaId,
      day,
      pricing_category: dim(p.pricing_category),
      pricing_type: dim(p.pricing_type),
      country: dim(p.country),
      volume: 0,
      cost: 0,
      currency: ctx.currency,
      fetched_at: ctx.fetchedAt,
    };
    const key = [
      row.day,
      row.pricing_category,
      row.pricing_type,
      row.country,
    ].join('|');
    const existing = byKey.get(key) ?? row;
    existing.volume += Number(p.volume) || 0;
    existing.cost = round4(existing.cost + (Number(p.cost) || 0));
    byKey.set(key, existing);
  }
  return [...byKey.values()].sort((a, b) =>
    a.day === b.day ? b.cost - a.cost : a.day.localeCompare(b.day)
  );
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Sync window: from the first day of last month (UTC) to now. */
export function defaultSyncWindow(now: Date): { start: number; end: number } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return { start: start / 1000, end: Math.floor(now.getTime() / 1000) };
}
