import { describe, expect, it } from 'vitest';
import {
  allocateAgentCost,
  burstSavings,
  parseMonthParam,
  shiftMonth,
  summarizeCost,
  type CostOverview,
} from './overview';

function overview(overrides: Partial<CostOverview> = {}): CostOverview {
  return {
    month: '2026-11-01',
    timezone: 'Asia/Almaty',
    meta: {
      volume: 19751,
      cost: 361.57,
      currency: 'USD',
      fetchedAt: null,
      breakdown: [
        {
          category: 'SERVICE',
          type: 'REGULAR',
          country: 'KZ',
          volume: 18557,
          cost: 334.03,
        },
        {
          category: 'MARKETING',
          type: 'REGULAR',
          country: 'KZ',
          volume: 445,
          cost: 26.88,
        },
        {
          category: 'SERVICE',
          type: 'REGULAR',
          country: 'DE',
          volume: 9,
          cost: 0.49,
        },
        {
          category: 'SERVICE',
          type: 'FREE_CUSTOMER_SERVICE',
          country: 'KZ',
          volume: 734,
          cost: 0,
        },
      ],
    },
    invoice: null,
    outbound: { total: 20051, bursts: 7211, repeats: 441, conversations: 2400 },
    origins: { agent: 20051 },
    agents: [
      agent({
        userId: 'a',
        outbound: 10000,
        conversations: 1000,
        bursts: 4000,
        dealsWon: 50,
      }),
      agent({
        userId: 'b',
        outbound: 10000,
        conversations: 2000,
        bursts: 2000,
        dealsWon: 0,
      }),
    ],
    daily: Array.from({ length: 30 }, (_, i) => ({
      day: `2026-11-${String(i + 1).padStart(2, '0')}`,
      outbound: 0,
      bursts: 0,
      metaVolume: i < 27 ? 700 : 0,
      metaCost: 0,
    })),
    ...overrides,
  };
}

function agent(
  a: Partial<CostOverview['agents'][number]>
): CostOverview['agents'][number] {
  return {
    userId: 'x',
    name: null,
    avatarUrl: null,
    outbound: 0,
    conversations: 0,
    bursts: 0,
    repeats: 0,
    voiceNotes: 0,
    media: 0,
    templates: 0,
    billable: 0,
    priced: 0,
    dealsWon: 0,
    wonValue: 0,
    ...a,
  };
}

describe('summarizeCost', () => {
  it('splits paid service, free service and templates', () => {
    const s = summarizeCost(overview(), new Date(2026, 10, 28, 12));
    expect(s.serviceCost).toBe(334.52);
    expect(s.serviceBillable).toBe(18566);
    expect(s.serviceFree).toBe(734);
    expect(s.templateCost).toBe(26.88);
    expect(s.serviceRate).toBeCloseTo(0.018, 3);
  });

  it('projects the month from days elapsed', () => {
    const s = summarizeCost(overview(), new Date(2026, 10, 15, 0));
    // 361.57 over 14 days → 30 days.
    expect(s.projectedCost).toBeCloseTo((361.57 / 14) * 30, 1);
  });

  it('uses the actual total once the month is over', () => {
    expect(summarizeCost(overview(), new Date(2026, 11, 2)).projectedCost).toBe(
      361.57
    );
  });

  it('has no rate or projection without Meta data', () => {
    const empty = overview({
      meta: {
        volume: 0,
        cost: 0,
        currency: null,
        fetchedAt: null,
        breakdown: [],
      },
      daily: [],
    });
    const s = summarizeCost(empty);
    expect(s.serviceRate).toBeNull();
    expect(s.projectedCost).toBeNull();
    expect(burstSavings(empty, s)).toBeNull();
  });
});

describe('allocateAgentCost', () => {
  it('splits service cost by outbound share', () => {
    const o = overview();
    const rows = allocateAgentCost(o, summarizeCost(o));
    expect(rows[0].estimatedCost).toBe(167.26);
    expect(rows[1].estimatedCost).toBe(167.26);
    expect(rows[0].burstShare).toBe(0.4);
    expect(rows[0].outboundPerConversation).toBe(10);
    expect(rows[0].costPerDealWon).toBeCloseTo(3.35, 2);
    expect(rows[1].costPerDealWon).toBeNull();
  });
});

describe('burstSavings', () => {
  it('values half the bursts at the service rate by default', () => {
    const o = overview();
    const s = summarizeCost(o);
    expect(burstSavings(o, s)).toBeCloseTo(7211 * 0.5 * s.serviceRate!, 1);
  });
});

describe('month helpers', () => {
  it('parses and shifts months', () => {
    const now = new Date(2026, 10, 28);
    expect(parseMonthParam('2026-10', now)).toBe('2026-10-01');
    expect(parseMonthParam('bad', now)).toBe('2026-11-01');
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01');
    expect(shiftMonth('2026-12-01', 1)).toBe('2027-01-01');
  });
});
