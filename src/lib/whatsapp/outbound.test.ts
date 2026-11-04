import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { MetaApiError } from './meta-api';
import {
  classifySendFailure,
  classifyStatusFailure,
  MAX_AUTO_RETRIES,
} from './outbound-failure';
import {
  beginOutboundMessage,
  completeOutboundMessage,
  failOutboundMessage,
  handleStatusFailure,
} from './outbound-state';

const NOW = Date.parse('2026-06-01T00:00:00Z');

interface Row {
  id: string;
  status: string;
  [key: string]: unknown;
}

/** Just enough of PostgREST to run the state changes against rows held in memory. */
function fakeDb(initial: Row[] = []) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  let nextId = 1;

  const query = (rowsFor: () => Row[], apply: (matched: Row[]) => unknown) => {
    const filters: ((row: Row) => boolean)[] = [];
    const chain = {
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return chain;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return chain;
      },
      select: () => chain,
      single: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      then(resolve: (value: unknown) => void) {
        resolve(apply(matched()));
      },
    };
    const matched = () => rowsFor().filter((row) => filters.every((f) => f(row)));
    return chain;
  };

  const db = {
    from: () => ({
      upsert(row: Record<string, unknown>) {
        const duplicate =
          row.client_request_id !== null &&
          [...rows.values()].find(
            (r) =>
              r.conversation_id === row.conversation_id &&
              r.client_request_id === row.client_request_id
          );
        const inserted: Row[] = [];
        if (!duplicate) {
          const created = { id: `row-${nextId++}`, ...row } as Row;
          rows.set(created.id, created);
          inserted.push(created);
        }
        return { select: () => Promise.resolve({ data: inserted, error: null }) };
      },
      select: () =>
        query(
          () => [...rows.values()],
          (matched) => ({ data: matched, error: null })
        ),
      update: (patch: Record<string, unknown>) =>
        query(
          () => [...rows.values()],
          (matched) => {
            matched.forEach((row) => Object.assign(row, patch));
            return { data: matched, error: null };
          }
        ),
    }),
  } as unknown as SupabaseClient;

  return { db, rows };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const meta = (fields: ConstructorParameters<typeof MetaApiError>[1], message = 'Meta error') =>
  new MetaApiError(message, fields);

describe('classifySendFailure', () => {
  it.each([
    ['a response with 131000 and no wamid', meta({ code: 131000, httpStatus: 500 }), 'auto'],
    ['HTTP 429', meta({ httpStatus: 429 }), 'auto'],
    ['throttling code 130429', meta({ code: 130429, httpStatus: 400 }), 'auto'],
    ['131049', meta({ code: 131049, httpStatus: 400 }), 'no_retry'],
    ['the 24-hour window, 131047', meta({ code: 131047, httpStatus: 400 }), 'manual'],
    ['a bad token, 190', meta({ code: 190, httpStatus: 401 }), 'manual'],
    ['spam limit 131048, which retrying could worsen', meta({ code: 131048, httpStatus: 400 }), 'manual'],
  ] as const)('%s', (_name, error, expected) => {
    expect(classifySendFailure(error)).toBe(expected);
  });

  // The duplicate-delivery rule: no proof it failed means no automatic resend.
  it.each([
    ['a timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' })],
    ['a dropped connection', new TypeError('fetch failed')],
    ['a 5xx with no Meta error body', meta({ httpStatus: 502 })],
  ])('treats %s as delivery_unknown', (_name, error) => {
    expect(classifySendFailure(error)).toBe('delivery_unknown');
  });
});

describe('classifyStatusFailure', () => {
  it('retries 131000, but not 131049', () => {
    expect(classifyStatusFailure(131000)).toBe('auto');
    expect(classifyStatusFailure(131049)).toBe('no_retry');
  });

  it('leaves other failures to an agent', () => {
    expect(classifyStatusFailure(131026)).toBe('manual');
    expect(classifyStatusFailure(null)).toBe('manual');
  });
});

describe('beginOutboundMessage: duplicate outbound prevention', () => {
  const fields = { conversation_id: 'conv-1', content_text: 'hi' };

  it('saves the row and moves it to sending', async () => {
    const { db, rows } = fakeDb();

    const result = await beginOutboundMessage(db, fields, 'req-1', { a: 1 }, NOW);

    expect(result).toEqual({ kind: 'new', id: 'row-1' });
    expect(rows.get('row-1')).toMatchObject({
      status: 'sending',
      client_request_id: 'req-1',
      send_attempts: 1,
      send_params: { a: 1 },
      sending_since: new Date(NOW).toISOString(),
    });
  });

  it('returns the original for a repeated request id rather than a new row', async () => {
    const { db, rows } = fakeDb();
    await beginOutboundMessage(db, fields, 'req-1', {}, NOW);
    rows.get('row-1')!.status = 'sent';
    rows.get('row-1')!.message_id = 'wamid.1';

    const result = await beginOutboundMessage(db, fields, 'req-1', {}, NOW);

    expect(result).toMatchObject({
      kind: 'duplicate',
      id: 'row-1',
      status: 'sent',
      whatsappMessageId: 'wamid.1',
    });
    expect(rows.size).toBe(1);
  });

  it('treats separate sends with no request id as separate messages', async () => {
    const { db, rows } = fakeDb();

    await beginOutboundMessage(db, fields, null, {}, NOW);
    await beginOutboundMessage(db, fields, null, {}, NOW);

    expect(rows.size).toBe(2);
  });
});

describe('completeOutboundMessage', () => {
  it('records the wamid and clears the earlier failure', async () => {
    const { db, rows } = fakeDb([
      { id: 'm', status: 'sending', error_code: 131000, retry_class: 'auto', sending_since: 'x' },
    ]);

    await completeOutboundMessage(db, 'm', 'wamid.9');

    expect(rows.get('m')).toMatchObject({
      status: 'sent',
      message_id: 'wamid.9',
      error_code: null,
      retry_class: null,
      sending_since: null,
    });
  });
});

describe('failOutboundMessage', () => {
  const sending = () => fakeDb([{ id: 'm', status: 'sending' }]);

  it('persists the full diagnostic detail', async () => {
    const { db, rows } = sending();

    await failOutboundMessage(
      db,
      'm',
      new MetaApiError('Something went wrong', {
        code: 131000,
        subcode: 2494010,
        fbtraceId: 'trace-1',
        httpStatus: 500,
        details: 'Internal',
      }),
      1,
      NOW,
      () => 0
    );

    expect(rows.get('m')).toMatchObject({
      error_code: 131000,
      error_subcode: 2494010,
      error_fbtrace_id: 'trace-1',
      error_http_status: 500,
      error_details: 'Internal',
      error_title: 'Something went wrong',
    });
  });

  it('schedules a 131000 for a later retry', async () => {
    const { db, rows } = sending();

    const outcome = await failOutboundMessage(db, 'm', meta({ code: 131000, httpStatus: 500 }), 1, NOW, () => 0.5);

    expect(outcome).toEqual({ status: 'queued', retryClass: 'auto' });
    expect(rows.get('m')).toMatchObject({
      status: 'queued',
      next_retry_at: new Date(NOW + 15_000).toISOString(),
    });
  });

  it('escalates a persistent 131000 to a person once retries run out', async () => {
    const { db, rows } = sending();
    const error = vi.spyOn(console, 'error');

    const outcome = await failOutboundMessage(
      db,
      'm',
      meta({ code: 131000, httpStatus: 500 }),
      MAX_AUTO_RETRIES + 1,
      NOW
    );

    expect(outcome).toEqual({ status: 'failed', retryClass: 'manual' });
    expect(rows.get('m')).toMatchObject({ status: 'failed', next_retry_at: null });
    expect(error.mock.calls.flat().join(' ')).toContain('outbound.retries_exhausted');
  });

  it('never schedules a resend for a 131049', async () => {
    const { db, rows } = sending();

    const outcome = await failOutboundMessage(db, 'm', meta({ code: 131049, httpStatus: 400 }), 1, NOW);

    expect(outcome).toEqual({ status: 'failed', retryClass: 'no_retry' });
    expect(rows.get('m')!.next_retry_at).toBeNull();
  });

  it('never schedules a resend after an ambiguous failure', async () => {
    const { db, rows } = sending();

    const outcome = await failOutboundMessage(db, 'm', new TypeError('fetch failed'), 1, NOW);

    expect(outcome).toEqual({ status: 'failed', retryClass: 'delivery_unknown' });
    expect(rows.get('m')).toMatchObject({
      next_retry_at: null,
      error_title: 'Delivery unknown',
    });
  });

  it('waits at least as long as Retry-After says', async () => {
    const { db, rows } = sending();

    await failOutboundMessage(db, 'm', meta({ httpStatus: 429, retryAfterSeconds: 300 }), 1, NOW, () => 0);

    expect(rows.get('m')!.next_retry_at).toBe(new Date(NOW + 300_000).toISOString());
  });

  it('leaves alone a row no longer in sending', async () => {
    const { db, rows } = fakeDb([{ id: 'm', status: 'sent' }]);

    await failOutboundMessage(db, 'm', meta({ code: 131000, httpStatus: 500 }), 1, NOW);

    expect(rows.get('m')!.status).toBe('sent');
  });
});

describe('handleStatusFailure: delivery webhook reconciliation', () => {
  const failed = (extra: Partial<Row> = {}) =>
    fakeDb([
      {
        id: 'm',
        status: 'failed',
        message_id: 'wamid.old',
        send_attempts: 1,
        send_params: { conversationId: 'c' },
        ...extra,
      },
    ]);

  it('requeues a 131000 and drops the old wamid so its late statuses cannot match', async () => {
    const { db, rows } = failed();

    await handleStatusFailure(db, ['m'], 131000, NOW, () => 0);

    expect(rows.get('m')).toMatchObject({
      status: 'queued',
      message_id: null,
      retry_class: 'auto',
      next_retry_at: new Date(NOW).toISOString(),
    });
  });

  it('records 131049 as failed, with no resend scheduled', async () => {
    const { db, rows } = failed();
    const warn = vi.spyOn(console, 'warn');

    await handleStatusFailure(db, ['m'], 131049, NOW);

    expect(rows.get('m')).toMatchObject({ status: 'failed', retry_class: 'no_retry' });
    expect(rows.get('m')!.next_retry_at).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('outbound.engagement_limit');
  });

  it('stops retrying a persistent 131000 and leaves it for a person', async () => {
    const { db, rows } = failed({ send_attempts: MAX_AUTO_RETRIES + 1 });

    await handleStatusFailure(db, ['m'], 131000, NOW);

    expect(rows.get('m')).toMatchObject({ status: 'failed', retry_class: 'manual' });
  });

  it('leaves rows from other send paths as the webhook left them', async () => {
    const { db, rows } = failed({ send_params: null });

    await handleStatusFailure(db, ['m'], 131000, NOW);

    expect(rows.get('m')).toMatchObject({ status: 'failed', message_id: 'wamid.old' });
    expect(rows.get('m')!.retry_class).toBeUndefined();
  });
});
