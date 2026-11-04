import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
  persist: vi.fn(),
  run: vi.fn(),
  processPayload: vi.fn(),
  signatureValid: true,
}));

vi.mock('next/server', () => ({
  after: (callback: () => unknown) => h.afterCallbacks.push(callback),
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  isLegacyFormat: vi.fn(),
}));
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => h.signatureValid,
  verifyTokenMatches: vi.fn(),
}));
vi.mock('@/lib/whatsapp/webhook-processor', () => ({
  processWebhookPayload: h.processPayload,
}));
vi.mock('@/lib/whatsapp/webhook-events', () => ({
  persistWebhookEvent: h.persist,
  runWebhookEvent: h.run,
}));

import { POST } from './route';

const post = (body = '{"entry":[]}') =>
  POST(
    new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=stub' },
      body,
    })
  ) as unknown as Promise<{ status: number }>;

beforeEach(() => {
  process.env.WEBHOOK_DURABLE_INTAKE = 'true';
  h.afterCallbacks = [];
  h.signatureValid = true;
  h.persist.mockReset();
  h.persist.mockResolvedValue({ id: 'event-1', error: null });
  h.run.mockReset();
  h.processPayload.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.WEBHOOK_DURABLE_INTAKE;
  vi.restoreAllMocks();
});

describe('POST /api/whatsapp/webhook with durable intake on', () => {
  it('saves the event before acknowledging', async () => {
    let savedBeforeResponse = false;
    h.persist.mockImplementationOnce(async () => {
      savedBeforeResponse = true;
      return { id: 'event-1', error: null };
    });

    const res = await post();

    expect(savedBeforeResponse).toBe(true);
    expect(res.status).toBe(200);
  });

  it('answers 503 when the save fails, so that Meta redelivers', async () => {
    h.persist.mockResolvedValueOnce({ id: null, error: 'database down' });

    const res = await post();

    expect(res.status).toBe(503);
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('processes the saved event after responding', async () => {
    await post();
    expect(h.run).not.toHaveBeenCalled();

    await h.afterCallbacks[0]();

    expect(h.run).toHaveBeenCalledWith(expect.anything(), 'event-1');
  });

  it('acknowledges a duplicate delivery without processing it again', async () => {
    h.persist.mockResolvedValueOnce({ id: null, error: null });

    const res = await post();

    expect(res.status).toBe(200);
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('keys duplicates on the exact bytes Meta signed', async () => {
    await post('{"entry":[1]}');
    await post('{"entry":[1]}');
    await post('{"entry":[2]}');

    const hashes = h.persist.mock.calls.map((call) => call[1]);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it('checks the signature first, and saves nothing unsigned', async () => {
    h.signatureValid = false;

    const res = await post();

    expect(res.status).toBe(401);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('saves nothing that is not valid JSON', async () => {
    const res = await post('not json');

    expect(res.status).toBe(400);
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/webhook with durable intake off', () => {
  it('keeps the previous behaviour and touches no new table', async () => {
    delete process.env.WEBHOOK_DURABLE_INTAKE;
    h.processPayload.mockResolvedValue({ failures: 0 });

    const res = await post();
    await h.afterCallbacks[0]();

    expect(res.status).toBe(200);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.processPayload).toHaveBeenCalledTimes(1);
  });
});
