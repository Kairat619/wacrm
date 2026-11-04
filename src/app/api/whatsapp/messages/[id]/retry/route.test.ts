import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  claimRows: [{ id: 'm1' }] as { id: string }[],
  claimPatch: null as Record<string, unknown> | null,
  resend: vi.fn(),
  role: { allowed: true },
  rateLimited: false,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
  },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => {
    if (!h.role.allowed) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return {
      accountId: 'acc',
      userId: 'agent-1',
      supabase: {
        from: () => {
          const chain = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: async () => ({ data: h.row, error: null }),
            update: (patch: Record<string, unknown>) => {
              h.claimPatch = patch;
              const updating = {
                eq: () => updating,
                select: async () => ({ data: h.claimRows, error: null }),
              };
              return updating;
            },
          };
          return chain;
        },
      },
    };
  },
  toErrorResponse: (error: { status?: number }) =>
    new Response(JSON.stringify({ error: 'failed' }), { status: error.status ?? 500 }),
}));

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { send: {} },
  checkRateLimit: () => ({ success: !h.rateLimited }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));

vi.mock('@/lib/whatsapp/outbound-retry', () => ({
  resendClaimedMessage: h.resend,
}));

vi.mock('@/lib/whatsapp/send-message', () => {
  class SendMessageError extends Error {
    status = 502;
    outbound = { retryClass: 'manual' };
  }
  return { SendMessageError };
});

import { POST } from './route';
import { SendMessageError } from '@/lib/whatsapp/send-message';

function call(body: unknown = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/messages/m1/retry', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'm1' }) }
  );
}

const failedRow = (extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  status: 'failed',
  retry_class: 'manual',
  send_params: { conversationId: 'c', messageType: 'text', contentText: 'hi' },
  send_attempts: 1,
  ...extra,
});

beforeEach(() => {
  h.row = failedRow();
  h.claimRows = [{ id: 'm1' }];
  h.claimPatch = null;
  h.role.allowed = true;
  h.rateLimited = false;
  h.resend.mockReset();
  h.resend.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/whatsapp/messages/[id]/retry', () => {
  it('resends the same row, with the agent as sender', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(h.resend).toHaveBeenCalledWith(
      expect.anything(),
      'acc',
      'm1',
      expect.objectContaining({ contentText: 'hi', senderId: 'agent-1' }),
      2
    );
    expect(h.claimPatch).toMatchObject({ status: 'sending', send_attempts: 2, message_id: null });
  });

  it('refuses a 131049-style failure, without sending', async () => {
    h.row = failedRow({ retry_class: 'no_retry', error_code: 131049 });

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'no_retry' });
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('needs explicit confirmation when it may already have been delivered', async () => {
    h.row = failedRow({ retry_class: 'delivery_unknown' });

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'confirmation_required' });
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('sends once the agent accepts the risk of a duplicate', async () => {
    h.row = failedRow({ retry_class: 'delivery_unknown' });

    const res = await call({ confirm_possible_duplicate: true });

    expect(res.status).toBe(200);
    expect(h.resend).toHaveBeenCalledTimes(1);
  });

  it.each(['queued', 'sending', 'sent', 'delivered', 'read'])(
    'refuses a message that is %s',
    async (status) => {
      h.row = failedRow({ status });

      expect((await call()).status).toBe(409);
      expect(h.resend).not.toHaveBeenCalled();
    }
  );

  it('sends once on a double click: the second click loses the claim', async () => {
    h.claimRows = [];

    const res = await call();

    expect(res.status).toBe(409);
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('cannot retry a row with no saved request', async () => {
    h.row = failedRow({ send_params: null });

    expect((await call()).status).toBe(409);
  });

  it('answers 404 for a message outside the account', async () => {
    h.row = null;

    expect((await call()).status).toBe(404);
  });

  it('refuses a caller without the agent role', async () => {
    h.role.allowed = false;

    expect((await call()).status).toBe(403);
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('applies the send rate limit', async () => {
    h.rateLimited = true;

    expect((await call()).status).toBe(429);
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('reports the new failure when the retry fails', async () => {
    h.resend.mockRejectedValueOnce(new (SendMessageError as unknown as new () => Error)());

    const res = await call();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ message_id: 'm1', retry_class: 'manual' });
  });
});
