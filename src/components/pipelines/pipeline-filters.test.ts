import { describe, expect, it } from 'vitest';
import type { Deal } from '@/types';
import {
  EMPTY_DEAL_FILTERS,
  filterDeals,
  hasActiveFilters,
} from './pipeline-filters';

function deal(partial: Partial<Deal> & { id: string; title: string }): Deal {
  return {
    user_id: 'u1',
    pipeline_id: 'p1',
    stage_id: 's1',
    contact_id: null,
    value: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  } as Deal;
}

const DEALS: Deal[] = [
  deal({
    id: '1',
    title: 'Proposal for bakery',
    status: 'open',
    assigned_to: 'rep-a',
    assignee: { full_name: 'Anna Rep' } as Deal['assignee'],
    contact: { name: 'Aigerim', phone: '+7 (701) 234-00-11' } as Deal['contact'],
  }),
  deal({
    id: '2',
    title: 'Website redesign',
    status: 'won',
    contact: { name: 'Bolat', phone: '+77029998877' } as Deal['contact'],
  }),
  deal({
    id: '3',
    title: 'Catering retainer',
    assigned_to: 'rep-b',
    assignee: { full_name: 'Bek Rep' } as Deal['assignee'],
  }),
];

const ids = (deals: Deal[]) => deals.map((d) => d.id);

describe('filterDeals', () => {
  it('returns everything with no filters applied', () => {
    expect(ids(filterDeals(DEALS, EMPTY_DEAL_FILTERS))).toEqual(['1', '2', '3']);
  });

  it('matches title, contact name and assignee case-insensitively', () => {
    const by = (search: string) =>
      ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, search }));
    expect(by('bakery')).toEqual(['1']);
    expect(by('BOLAT')).toEqual(['2']);
    expect(by('bek')).toEqual(['3']);
  });

  it('requires every term to match', () => {
    const search = 'anna proposal';
    expect(ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, search }))).toEqual([
      '1',
    ]);
    expect(
      filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, search: 'anna redesign' }),
    ).toEqual([]);
  });

  it('matches a phone regardless of formatting', () => {
    const search = '7012340011';
    expect(ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, search }))).toEqual([
      '1',
    ]);
  });

  it('treats a missing status as open', () => {
    expect(
      ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, status: 'open' })),
    ).toEqual(['1', '3']);
    expect(
      ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, status: 'won' })),
    ).toEqual(['2']);
  });

  it('filters by assignee and by unassigned', () => {
    expect(
      ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, assignee: 'rep-b' })),
    ).toEqual(['3']);
    expect(
      ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, assignee: 'unassigned' })),
    ).toEqual(['2']);
  });
});

describe('hasActiveFilters', () => {
  it('ignores a whitespace-only query', () => {
    expect(hasActiveFilters(EMPTY_DEAL_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_DEAL_FILTERS, search: '  ' })).toBe(
      false,
    );
    expect(hasActiveFilters({ ...EMPTY_DEAL_FILTERS, status: 'lost' })).toBe(
      true,
    );
  });
});
