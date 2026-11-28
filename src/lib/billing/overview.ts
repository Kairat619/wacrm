import type { SupabaseClient } from '@supabase/supabase-js';

/** Shape returned by the `message_cost_overview` RPC (migration 065). */
export interface CostBreakdownRow {
  category: string;
  type: string;
  country: string;
  volume: number;
  cost: number;
}

export interface CostAgentRow {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  outbound: number;
  conversations: number;
  bursts: number;
  repeats: number;
  voiceNotes: number;
  media: number;
  templates: number;
  billable: number;
  priced: number;
  dealsWon: number;
  wonValue: number;
}

export interface CostDailyRow {
  day: string;
  outbound: number;
  bursts: number;
  metaVolume: number;
  metaCost: number;
}

export interface CostOverview {
  month: string;
  timezone: string;
  meta: {
    volume: number;
    cost: number;
    currency: string | null;
    fetchedAt: string | null;
    breakdown: CostBreakdownRow[];
  };
  invoice: { amount: number; currency: string; note: string | null } | null;
  outbound: {
    total: number;
    bursts: number;
    repeats: number;
    conversations: number;
  };
  origins: Record<string, number>;
  agents: CostAgentRow[];
  daily: CostDailyRow[];
}

export async function loadCostOverview(
  db: SupabaseClient,
  month: string,
  timeZone: string
): Promise<CostOverview> {
  const { data, error } = await db.rpc('message_cost_overview', {
    p_month: month,
    p_tz: timeZone,
  });
  if (error) throw new Error(error.message);
  return data as CostOverview;
}

/** `YYYY-MM-01` for the month containing `date` in local time. */
export function monthKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** Shift a `YYYY-MM-01` key by whole months. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

/** Parse `?month=YYYY-MM`; falls back to the current month. */
export function parseMonthParam(value: string | null, now: Date): string {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return `${value}-01`;
  return monthKey(now);
}

export interface CostSummary {
  /** Meta's paid cost for service replies (category SERVICE). */
  serviceCost: number;
  /** Paid service replies. */
  serviceBillable: number;
  /** Service replies inside the free tier / free windows. */
  serviceFree: number;
  /** Cost of templates (marketing, utility, authentication). */
  templateCost: number;
  /** Cost per paid service reply; null until Meta reports any. */
  serviceRate: number | null;
  /** Projected cost for the full month, scaled from the days elapsed. */
  projectedCost: number | null;
}

/** Roll Meta's breakdown up into the numbers the page leads with. */
export function summarizeCost(
  overview: CostOverview,
  now: Date = new Date()
): CostSummary {
  let serviceCost = 0;
  let serviceBillable = 0;
  let serviceFree = 0;
  let templateCost = 0;
  for (const row of overview.meta.breakdown) {
    if (row.category === 'SERVICE') {
      if (row.cost > 0) {
        serviceCost += row.cost;
        serviceBillable += row.volume;
      } else {
        serviceFree += row.volume;
      }
    } else {
      templateCost += row.cost;
    }
  }
  return {
    serviceCost: round2(serviceCost),
    serviceBillable,
    serviceFree,
    templateCost: round2(templateCost),
    serviceRate: serviceBillable > 0 ? serviceCost / serviceBillable : null,
    projectedCost: projectMonth(overview, now),
  };
}

function projectMonth(overview: CostOverview, now: Date): number | null {
  const daysWithData = overview.daily.filter((d) => d.metaVolume > 0);
  if (daysWithData.length === 0) return null;
  const [y, m] = overview.month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 1);
  if (now >= monthEnd) return round2(overview.meta.cost);
  const elapsedDays = Math.max(
    1,
    (now.getTime() - monthStart.getTime()) / 86_400_000
  );
  const totalDays = (monthEnd.getTime() - monthStart.getTime()) / 86_400_000;
  return round2((overview.meta.cost / elapsedDays) * totalDays);
}

export interface AgentCostRow extends CostAgentRow {
  /** Share of the month's paid service cost, by outbound volume. */
  estimatedCost: number;
  /** Bursts as a share of outbound (0–1). */
  burstShare: number;
  outboundPerConversation: number;
  costPerDealWon: number | null;
}

/**
 * Attribute Meta's service cost to reps in proportion to the messages they
 * sent. Meta bills at the number level, so this is an allocation, not a
 * per-message bill: it answers "whose messages drove the cost".
 */
export function allocateAgentCost(
  overview: CostOverview,
  summary: CostSummary
): AgentCostRow[] {
  const outboundByAgents = overview.agents.reduce((n, a) => n + a.outbound, 0);
  return overview.agents.map((a) => {
    const share = outboundByAgents > 0 ? a.outbound / outboundByAgents : 0;
    const estimatedCost = round2(summary.serviceCost * share);
    return {
      ...a,
      estimatedCost,
      burstShare: a.outbound > 0 ? a.bursts / a.outbound : 0,
      outboundPerConversation:
        a.conversations > 0 ? a.outbound / a.conversations : 0,
      costPerDealWon:
        a.dealsWon > 0 ? round2(estimatedCost / a.dealsWon) : null,
    };
  });
}

/**
 * What merging back-to-back messages would have saved this month: each
 * burst message is one that could have been part of the previous one.
 * `mergeRate` is the share of bursts assumed avoidable (photos and voice
 * notes often can't be merged).
 */
export function burstSavings(
  overview: CostOverview,
  summary: CostSummary,
  mergeRate = 0.5
): number | null {
  if (summary.serviceRate == null) return null;
  return round2(overview.outbound.bursts * mergeRate * summary.serviceRate);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
