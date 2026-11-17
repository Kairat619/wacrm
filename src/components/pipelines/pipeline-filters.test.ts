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
    assignee: { full_name: 'Anna Rep' } as Deal['assignee'],
    contact: { name: 'Aigerim', phone: '+7 (701) 234-00-11' } as Deal['contact'],
  }),
  deal({
    id: '2',
    title: 'Website redesign',
    contact: { name: 'Bolat', phone: '+77029998877' } as Deal['contact'],
  }),
  deal({
    id: '3',
    title: 'Catering retainer',
    assignee: { full_name: 'Bek Rep' } as Deal['assignee'],
  }),
];

const ids = (deals: Deal[]) => deals.map((d) => d.id);
const search = (search: string) =>
  ids(filterDeals(DEALS, { ...EMPTY_DEAL_FILTERS, search }));

describe('filterDeals', () => {
  it('returns everything with an empty query', () => {
    expect(ids(filterDeals(DEALS, EMPTY_DEAL_FILTERS))).toEqual(['1', '2', '3']);
  });

  it('matches title, contact name and assignee case-insensitively', () => {
    expect(search('bakery')).toEqual(['1']);
    expect(search('BOLAT')).toEqual(['2']);
    expect(search('bek')).toEqual(['3']);
  });

  it('requires every term to match', () => {
    expect(search('anna proposal')).toEqual(['1']);
    expect(search('anna redesign')).toEqual([]);
  });

  it('matches a phone regardless of formatting', () => {
    expect(search('7012340011')).toEqual(['1']);
  });
});

describe('hasActiveFilters', () => {
  it('ignores a whitespace-only query', () => {
    expect(hasActiveFilters(EMPTY_DEAL_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_DEAL_FILTERS, search: '  ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_DEAL_FILTERS, search: 'bakery' })).toBe(true);
  });

  it('counts a date bound as active', () => {
    expect(hasActiveFilters({ ...EMPTY_DEAL_FILTERS, createdFrom: '2026-11-01' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_DEAL_FILTERS, createdTo: '2026-11-15' })).toBe(true);
  });
});

describe('filterDeals by creation date', () => {
  // Noon UTC so the local calendar day is the same in any zone from
  // UTC-11 to UTC+11 — keeps the test independent of the runner's TZ.
  const DATED: Deal[] = [
    deal({ id: 'oct31', title: 'a', created_at: '2026-10-31T12:00:00Z' }),
    deal({ id: 'nov01', title: 'b', created_at: '2026-11-01T12:00:00Z' }),
    deal({ id: 'nov15', title: 'c', created_at: '2026-11-15T12:00:00Z' }),
    deal({ id: 'nov16', title: 'd', created_at: '2026-11-16T12:00:00Z' }),
  ];
  const range = (createdFrom: string, createdTo: string) =>
    ids(filterDeals(DATED, { ...EMPTY_DEAL_FILTERS, createdFrom, createdTo }));

  it('includes both end days', () => {
    expect(range('2026-11-01', '2026-11-15')).toEqual(['nov01', 'nov15']);
  });

  it('treats an empty bound as open-ended', () => {
    expect(range('2026-11-15', '')).toEqual(['nov15', 'nov16']);
    expect(range('', '2026-11-01')).toEqual(['oct31', 'nov01']);
  });

  it('combines with search', () => {
    expect(
      ids(
        filterDeals(DATED, {
          search: 'b',
          createdFrom: '2026-11-01',
          createdTo: '2026-11-15',
        }),
      ),
    ).toEqual(['nov01']);
  });
});
