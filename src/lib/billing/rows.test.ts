import { describe, expect, it } from 'vitest';
import { defaultSyncWindow, toBillingRows } from './rows';

const ctx = {
  accountId: 'acc-1',
  wabaId: 'waba-1',
  currency: 'USD',
  fetchedAt: '2026-11-28T00:00:00.000Z',
};

describe('toBillingRows', () => {
  it('keys by the UTC day of the bucket midpoint', () => {
    // Bucket Nov 13 19:00 UTC → Nov 14 19:00 UTC = Nov 14 in Almaty (UTC+5).
    const rows = toBillingRows(
      [
        {
          start: 1794596400,
          end: 1794682800,
          volume: 858,
          cost: 15.444,
          country: 'KZ',
          pricing_type: 'REGULAR',
          pricing_category: 'SERVICE',
        },
      ],
      ctx
    );
    expect(rows).toEqual([
      expect.objectContaining({
        day: '2026-11-14',
        pricing_category: 'SERVICE',
        pricing_type: 'REGULAR',
        country: 'KZ',
        volume: 858,
        cost: 15.444,
        currency: 'USD',
      }),
    ]);
  });

  it('sums duplicate keys and fills missing dimensions', () => {
    const rows = toBillingRows(
      [
        { start: 0, end: 86400, volume: 2, cost: 0.01 },
        { start: 0, end: 86400, volume: 3, cost: 0.02 },
      ],
      ctx
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pricing_category: 'UNKNOWN',
      country: 'UNKNOWN',
      volume: 5,
      cost: 0.03,
    });
  });
});

describe('defaultSyncWindow', () => {
  it('starts on the first of last month', () => {
    const w = defaultSyncWindow(new Date('2026-01-15T10:00:00Z'));
    expect(new Date(w.start * 1000).toISOString()).toBe(
      '2025-12-01T00:00:00.000Z'
    );
  });
});
