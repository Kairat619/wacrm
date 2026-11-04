import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// The real processor pulls in every engine; these tests only need its contract.
vi.mock('./webhook-processor', () => ({ processWebhookPayload: vi.fn() }));

import {
  persistWebhookEvent,
  pruneWebhookEvents,
  recoverWebhookEvents,
  runWebhookEvent,
  WEBHOOK_EVENT_MAX_ATTEMPTS,
} from './webhook-events';

const PAYLOAD = { entry: [] };

interface Update {
  patch: Record<string, unknown>;
  id: unknown;
}

function fakeDb(options: {
  upsert?: { data: unknown; error: { message: string } | null };
  claimed?: { id: string; payload: unknown; attempts: number }[];
}) {
  const updates: Update[] = [];
  const deletes: unknown[][] = [];
  const rpc = vi.fn(async () => ({ data: options.claimed ?? [], error: null }));
  const db = {
    rpc,
    from: () => ({
      upsert: () => ({
        select: async () => options.upsert ?? { data: [{ id: 'e1' }], error: null },
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_column: string, id: unknown) => {
          updates.push({ patch, id });
          return { error: null };
        },
      }),
      delete: () => {
        const filters: unknown[] = [];
        const chain = {
          eq: (...args: unknown[]) => (filters.push(args), chain),
          lt: async (...args: unknown[]) => {
            filters.push(args);
            deletes.push(filters);
            return { error: null };
          },
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { db, updates, deletes, rpc };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('persistWebhookEvent', () => {
  it('returns the id on first sight', async () => {
    const { db } = fakeDb({});

    await expect(persistWebhookEvent(db, 'hash', PAYLOAD)).resolves.toEqual({
      id: 'e1',
      error: null,
    });
  });

  it('returns no id for a duplicate delivery, so it is not processed again', async () => {
    const { db } = fakeDb({ upsert: { data: [], error: null } });

    await expect(persistWebhookEvent(db, 'hash', PAYLOAD)).resolves.toEqual({
      id: null,
      error: null,
    });
  });

  it('reports a failed save, so the route can refuse to acknowledge', async () => {
    const { db } = fakeDb({ upsert: { data: null, error: { message: 'down' } } });

    await expect(persistWebhookEvent(db, 'hash', PAYLOAD)).resolves.toEqual({
      id: null,
      error: 'down',
    });
  });
});

describe('runWebhookEvent', () => {
  const claimed = (attempts = 1) => [{ id: 'e1', payload: PAYLOAD, attempts }];

  it('marks the event done after a clean run', async () => {
    const { db, updates } = fakeDb({ claimed: claimed() });
    const process = vi.fn(async () => ({ failures: 0 }));

    await runWebhookEvent(db, 'e1', process);

    expect(process).toHaveBeenCalledWith(PAYLOAD);
    expect(updates[0].patch).toMatchObject({ status: 'done', last_error: null });
  });

  it('does nothing when another process claimed the event first', async () => {
    const { db, updates } = fakeDb({ claimed: [] });
    const process = vi.fn();

    await runWebhookEvent(db, 'e1', process);

    expect(process).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('schedules a retry when any item failed', async () => {
    const { db, updates } = fakeDb({ claimed: claimed() });

    await runWebhookEvent(db, 'e1', async () => ({ failures: 2 }));

    expect(updates[0].patch).toMatchObject({
      status: 'pending',
      last_error: '2 item(s) failed',
      next_attempt_at: expect.any(String),
    });
  });

  it('schedules a retry when processing throws, and does not throw itself', async () => {
    const { db, updates } = fakeDb({ claimed: claimed() });

    await expect(
      runWebhookEvent(db, 'e1', async () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();

    expect(updates[0].patch).toMatchObject({ status: 'pending', last_error: 'boom' });
  });

  it('gives up after the last attempt rather than retrying forever', async () => {
    const { db, updates } = fakeDb({ claimed: claimed(WEBHOOK_EVENT_MAX_ATTEMPTS) });

    await runWebhookEvent(db, 'e1', async () => ({ failures: 1 }));

    expect(updates[0].patch).toMatchObject({ status: 'failed' });
  });
});

describe('recoverWebhookEvents', () => {
  it('processes what the claim returns, and reports how many', async () => {
    const { db, updates, rpc } = fakeDb({
      claimed: [
        { id: 'e1', payload: PAYLOAD, attempts: 2 },
        { id: 'e2', payload: PAYLOAD, attempts: 1 },
      ],
    });
    const process = vi.fn(async () => ({ failures: 0 }));

    await expect(recoverWebhookEvents(db, 20, process)).resolves.toBe(2);

    expect(process).toHaveBeenCalledTimes(2);
    expect(updates.map((u) => u.id)).toEqual(['e1', 'e2']);
    expect(rpc).toHaveBeenCalledWith(
      'claim_webhook_events',
      expect.objectContaining({ p_limit: 20, p_id: null })
    );
  });
});

describe('pruneWebhookEvents', () => {
  it('keeps finished payloads for 7 days and failed ones for 30', async () => {
    const { db, deletes } = fakeDb({});
    const now = Date.parse('2026-06-30T00:00:00Z');

    await pruneWebhookEvents(db, now);

    expect(deletes).toEqual([
      [
        ['status', 'done'],
        ['created_at', '2026-06-23T00:00:00.000Z'],
      ],
      [
        ['status', 'failed'],
        ['created_at', '2026-05-31T00:00:00.000Z'],
      ],
    ]);
  });
});
