import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  sendText: vi.fn(),
  order: [] as string[],
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: h.sendText,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'token',
  encrypt: (value: string) => value,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/message-status-sync', () => ({
  applyPendingMessageStatuses: vi.fn(async () => []),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
  }),
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { sendMessageToConversation, SendMessageError } from './send-message';
import { resendClaimedMessage } from './outbound-retry';

interface Row {
  id: string;
  status: string;
  [key: string]: unknown;
}

/** In-memory `messages` table plus the two lookups the send core makes first. */
function fakeDb(options: { failCompletion?: boolean } = {}) {
  const messages = new Map<string, Row>();
  let nextId = 1;

  const filterable = (apply: (matched: Row[]) => unknown) => {
    const filters: ((row: Row) => boolean)[] = [];
    const matched = () => [...messages.values()].filter((row) => filters.every((f) => f(row)));
    const chain = {
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return chain;
      },
      select: () => chain,
      single: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => void) => resolve(apply(matched())),
    };
    return chain;
  };

  const db = {
    from(table: string) {
      if (table === 'messages') {
        return {
          upsert(row: Record<string, unknown>) {
            const dup = [...messages.values()].find(
              (m) =>
                row.client_request_id != null &&
                m.conversation_id === row.conversation_id &&
                m.client_request_id === row.client_request_id
            );
            const inserted: Row[] = [];
            if (!dup) {
              const created = { id: `row-${nextId++}`, ...row } as Row;
              messages.set(created.id, created);
              inserted.push(created);
              h.order.push('row saved');
            }
            return { select: async () => ({ data: inserted, error: null }) };
          },
          select: () => filterable((rows) => ({ data: rows, error: null })),
          update: (patch: Record<string, unknown>) =>
            filterable((rows) => {
              if (patch.status === 'sent' && options.failCompletion) {
                return { data: null, error: { message: 'connection reset' } };
              }
              rows.forEach((row) => Object.assign(row, patch));
              return { data: rows, error: null };
            }),
          insert() {
            throw new Error('the persist-first path must not insert after sending');
          },
        };
      }
      // conversations / whatsapp_config / contacts
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        then: (resolve: (value: unknown) => void) => resolve({ error: null }),
        single: async () => ({
          data:
            table === 'conversations'
              ? { id: 'conv-1', contact: { id: 'c1', phone: '15551230000' } }
              : { id: 'cfg', phone_number_id: 'pn', access_token: 'enc' },
          error: null,
        }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;

  return { db, messages };
}

const PARAMS = {
  conversationId: 'conv-1',
  messageType: 'text',
  contentText: 'hello',
  clientRequestId: 'req-1',
};

beforeEach(() => {
  process.env.OUTBOUND_PERSIST_FIRST = 'true';
  h.order = [];
  h.sendText.mockReset();
  h.sendText.mockImplementation(async () => {
    h.order.push('meta called');
    return { messageId: 'wamid.1' };
  });
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  delete process.env.OUTBOUND_PERSIST_FIRST;
  vi.restoreAllMocks();
});

describe('sendMessageToConversation with persist-first on', () => {
  it('saves the row before calling Meta', async () => {
    const { db } = fakeDb();

    await sendMessageToConversation(db, 'acc', PARAMS);

    expect(h.order).toEqual(['row saved', 'meta called']);
  });

  it('ends at sent, holding the wamid', async () => {
    const { db, messages } = fakeDb();

    const result = await sendMessageToConversation(db, 'acc', PARAMS);

    expect(result).toEqual({ messageId: 'row-1', whatsappMessageId: 'wamid.1' });
    expect(messages.get('row-1')).toMatchObject({
      status: 'sent',
      message_id: 'wamid.1',
      content_text: 'hello',
      send_attempts: 1,
    });
  });

  describe('duplicate outbound prevention', () => {
    it('does not call Meta again for a repeated request', async () => {
      const { db, messages } = fakeDb();

      const first = await sendMessageToConversation(db, 'acc', PARAMS);
      const second = await sendMessageToConversation(db, 'acc', PARAMS);

      expect(h.sendText).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(messages.size).toBe(1);
    });

    it('refuses a repeat while the first is still unresolved, without sending', async () => {
      const { db, messages } = fakeDb();
      messages.set('row-9', {
        id: 'row-9',
        status: 'sending',
        conversation_id: 'conv-1',
        client_request_id: 'req-1',
        message_id: null,
      });

      const error = await sendMessageToConversation(db, 'acc', PARAMS).catch((e) => e);

      expect(error).toBeInstanceOf(SendMessageError);
      expect(error.status).toBe(409);
      expect(error.outbound.messageId).toBe('row-9');
      expect(h.sendText).not.toHaveBeenCalled();
    });

    it('reports success when Meta accepted but the save failed, so nobody resends', async () => {
      const { db, messages } = fakeDb({ failCompletion: true });

      const result = await sendMessageToConversation(db, 'acc', PARAMS);

      expect(result.whatsappMessageId).toBe('wamid.1');
      // Left in `sending`, for the sweep to flag as delivery_unknown.
      expect(messages.get('row-1')!.status).toBe('sending');
    });
  });

  describe('failures from Meta', () => {
    const failWith = (error: unknown) => h.sendText.mockRejectedValueOnce(error);

    it('131049: saved as failed, no retry, Meta called once', async () => {
      failWith(new MetaApiError('Engagement limit', { code: 131049, httpStatus: 400 }));
      const { db, messages } = fakeDb();

      const error = await sendMessageToConversation(db, 'acc', PARAMS).catch((e) => e);

      expect(error).toBeInstanceOf(SendMessageError);
      expect(error.outbound).toEqual({
        messageId: 'row-1',
        status: 'failed',
        retryClass: 'no_retry',
      });
      expect(messages.get('row-1')).toMatchObject({
        status: 'failed',
        error_code: 131049,
        next_retry_at: null,
      });
      expect(h.sendText).toHaveBeenCalledTimes(1);
    });

    it('131000: saved with its diagnostics and scheduled for a retry', async () => {
      failWith(
        new MetaApiError('Something went wrong', {
          code: 131000,
          fbtraceId: 'trace-9',
          httpStatus: 500,
        })
      );
      const { db, messages } = fakeDb();

      const error = await sendMessageToConversation(db, 'acc', PARAMS).catch((e) => e);

      expect(error.outbound).toMatchObject({ status: 'queued', retryClass: 'auto' });
      expect(error.meta).toMatchObject({ code: 131000, fbtraceId: 'trace-9' });
      expect(messages.get('row-1')).toMatchObject({
        status: 'queued',
        error_code: 131000,
        error_fbtrace_id: 'trace-9',
        error_http_status: 500,
      });
      expect(messages.get('row-1')!.next_retry_at).toEqual(expect.any(String));
    });

    it('a dropped connection is never scheduled for a resend', async () => {
      failWith(new TypeError('fetch failed'));
      const { db, messages } = fakeDb();

      const error = await sendMessageToConversation(db, 'acc', PARAMS).catch((e) => e);

      expect(error.outbound).toMatchObject({
        status: 'failed',
        retryClass: 'delivery_unknown',
      });
      expect(messages.get('row-1')!.next_retry_at).toBeNull();
    });

    it('stays saved, so it survives a page reload', async () => {
      failWith(new MetaApiError('Bad', { code: 100, httpStatus: 400 }));
      const { db, messages } = fakeDb();

      await sendMessageToConversation(db, 'acc', PARAMS).catch(() => {});

      expect(messages.get('row-1')).toMatchObject({
        status: 'failed',
        retry_class: 'manual',
        send_params: expect.objectContaining({ contentText: 'hello' }),
      });
    });
  });

  describe('resending a claimed row', () => {
    const claimedRow = (attempts: number): Row => ({
      id: 'row-5',
      status: 'sending',
      conversation_id: 'conv-1',
      send_attempts: attempts,
    });

    it('reuses the row rather than saving another', async () => {
      const { db, messages } = fakeDb();
      messages.set('row-5', claimedRow(2));

      await resendClaimedMessage(db, 'acc', 'row-5', PARAMS, 2);

      expect(messages.size).toBe(1);
      expect(messages.get('row-5')).toMatchObject({ status: 'sent', message_id: 'wamid.1' });
    });

    it('stops scheduling retries after the last allowed attempt', async () => {
      h.sendText.mockRejectedValueOnce(
        new MetaApiError('Something went wrong', { code: 131000, httpStatus: 500 })
      );
      const { db, messages } = fakeDb();
      messages.set('row-5', claimedRow(3));

      await resendClaimedMessage(db, 'acc', 'row-5', PARAMS, 3).catch(() => {});

      expect(messages.get('row-5')).toMatchObject({ status: 'failed', retry_class: 'manual' });
    });

    it('records a failure before Meta is reached, rather than leaving it stuck', async () => {
      const { db, messages } = fakeDb();
      messages.set('row-5', claimedRow(2));

      await expect(
        resendClaimedMessage(db, 'acc', 'row-5', { ...PARAMS, messageType: 'nonsense' }, 2)
      ).rejects.toBeInstanceOf(SendMessageError);

      expect(messages.get('row-5')).toMatchObject({ status: 'failed', retry_class: 'manual' });
      expect(h.sendText).not.toHaveBeenCalled();
    });
  });
});

describe('sendMessageToConversation with persist-first off', () => {
  it('keeps the original order: Meta first, then insert', async () => {
    delete process.env.OUTBOUND_PERSIST_FIRST;
    const { db, messages } = fakeDb();
    const inserted: unknown[] = [];
    const from = db.from.bind(db);
    (db as unknown as { from: unknown }).from = (table: string) =>
      table === 'messages'
        ? {
            insert: (row: unknown) => {
              inserted.push(row);
              return { select: () => ({ single: async () => ({ data: { id: 'm1' }, error: null }) }) };
            },
          }
        : from(table);

    const result = await sendMessageToConversation(db, 'acc', PARAMS);

    expect(result).toEqual({ messageId: 'm1', whatsappMessageId: 'wamid.1' });
    expect(inserted[0]).toMatchObject({ status: 'sent', message_id: 'wamid.1' });
    expect(messages.size).toBe(0);
  });
});
