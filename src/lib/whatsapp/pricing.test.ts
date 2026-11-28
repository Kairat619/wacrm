import { describe, expect, it } from 'vitest';
import { parseStatusPricing, pricingColumns } from './pricing';

describe('parseStatusPricing', () => {
  it('normalizes Meta per-message pricing', () => {
    expect(
      parseStatusPricing({
        billable: true,
        pricing_model: 'PMP',
        category: 'service',
        type: 'regular',
      })
    ).toEqual({
      billable: true,
      category: 'service',
      type: 'regular',
      model: 'pmp',
    });
  });

  it('keeps a free service reply as non-billable', () => {
    expect(
      parseStatusPricing({
        billable: false,
        pricing_model: 'PMP',
        category: 'service',
        type: 'free_customer_service',
      })
    ).toMatchObject({ billable: false, type: 'free_customer_service' });
  });

  it('returns null for missing or junk input', () => {
    expect(parseStatusPricing(undefined)).toBeNull();
    expect(parseStatusPricing('x')).toBeNull();
    expect(parseStatusPricing({ billable: 'yes', category: 7 })).toBeNull();
  });

  it('builds the column patch', () => {
    expect(
      pricingColumns(
        { billable: true, category: 'marketing', type: 'regular', model: 'pmp' },
        '2026-11-01T00:00:00.000Z'
      )
    ).toEqual({
      pricing_billable: true,
      pricing_category: 'marketing',
      pricing_type: 'regular',
      pricing_model: 'pmp',
      priced_at: '2026-11-01T00:00:00.000Z',
    });
  });
});
