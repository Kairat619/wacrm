import type { SupabaseClient } from '@supabase/supabase-js';

import { logEvent } from '@/lib/observability/log';
import { backoffDelayMs } from '@/lib/reliability/backoff';
import {
  processWebhookPayload,
  type WebhookProcessingResult,
  type WhatsAppWebhookEntry,
} from './webhook-processor';

/**
 * Durable record of each verified webhook delivery (migration 061).
 *
 * An event is saved before Meta gets its 200, then processed straight away by
 * the route's `after()`. If that run dies or reports a failure, the worker picks
 * the event up again. Replays are safe: see `webhook-processor.ts`.
 *
 * One known limit: flows, automations and AI replies run at most once. If the
 * process dies after the message insert but before they finish, a replay does
 * not re-run them, because that could send a customer the same bot message twice.
 */

export type WebhookPayload = { entry?: WhatsAppWebhookEntry[] };

interface ClaimedEvent {
  id: string;
  payload: WebhookPayload;
  attempts: number;
}

export const WEBHOOK_EVENT_MAX_ATTEMPTS = 8;
/** Longer than any single payload should take; recovery waits this long. */
const LEASE_SECONDS = 300;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
export const DONE_RETENTION_DAYS = 7;
export const FAILED_RETENTION_DAYS = 30;

type Process = (payload: WebhookPayload) => Promise<WebhookProcessingResult>;

/**
 * Save a delivery. Returns its id on first sight, `null` id when the identical
 * payload was already saved, and an error message when the save failed, in which
 * case the caller must not acknowledge.
 */
export async function persistWebhookEvent(
  db: SupabaseClient,
  payloadHash: string,
  payload: WebhookPayload
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await db
    .from('webhook_events')
    .upsert(
      { payload_hash: payloadHash, payload },
      { onConflict: 'payload_hash', ignoreDuplicates: true }
    )
    .select('id');
  if (error) return { id: null, error: error.message };
  return { id: data?.[0]?.id ?? null, error: null };
}

async function settle(
  db: SupabaseClient,
  event: ClaimedEvent,
  run: () => Promise<WebhookProcessingResult>
): Promise<void> {
  let failure: string | null = null;
  try {
    const { failures } = await run();
    if (failures > 0) failure = `${failures} item(s) failed`;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const now = Date.now();
  if (!failure) {
    const { error } = await db
      .from('webhook_events')
      .update({
        status: 'done',
        processed_at: new Date(now).toISOString(),
        locked_until: null,
        last_error: null,
      })
      .eq('id', event.id);
    if (error) {
      logEvent('error', 'webhook.settle_failed', { event_id: event.id, error: error.message });
    }
    return;
  }

  const exhausted = event.attempts >= WEBHOOK_EVENT_MAX_ATTEMPTS;
  const { error } = await db
    .from('webhook_events')
    .update({
      status: exhausted ? 'failed' : 'pending',
      locked_until: null,
      last_error: failure,
      next_attempt_at: new Date(
        now +
          backoffDelayMs(event.attempts, {
            baseMs: RETRY_BASE_MS,
            maxMs: RETRY_MAX_MS,
          })
      ).toISOString(),
    })
    .eq('id', event.id);
  if (error) {
    logEvent('error', 'webhook.settle_failed', { event_id: event.id, error: error.message });
  }
  logEvent(exhausted ? 'error' : 'warn', exhausted ? 'webhook.event_failed' : 'webhook.event_retry', {
    event_id: event.id,
    attempts: event.attempts,
    error: failure,
  });
}

async function claim(
  db: SupabaseClient,
  limit: number,
  id: string | null
): Promise<ClaimedEvent[]> {
  const { data, error } = await db.rpc('claim_webhook_events', {
    p_limit: limit,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: WEBHOOK_EVENT_MAX_ATTEMPTS,
    p_id: id,
  });
  if (error) {
    logEvent('error', 'webhook.claim_failed', { error: error.message });
    return [];
  }
  return (data ?? []) as ClaimedEvent[];
}

/** Process one just-saved event from the route. Never throws. */
export async function runWebhookEvent(
  db: SupabaseClient,
  id: string,
  process: Process = processWebhookPayload
): Promise<void> {
  try {
    for (const event of await claim(db, 1, id)) {
      await settle(db, event, () => process(event.payload));
    }
  } catch (error) {
    logEvent('error', 'webhook.run_failed', { event_id: id, error });
  }
}

/** Worker sweep: unfinished events, including those whose process died. */
export async function recoverWebhookEvents(
  db: SupabaseClient,
  limit: number,
  process: Process = processWebhookPayload
): Promise<number> {
  const events = await claim(db, limit, null);
  for (const event of events) {
    await settle(db, event, () => process(event.payload));
  }
  return events.length;
}

/**
 * Payloads hold customer messages and phone numbers, so they are kept only long
 * enough to diagnose a problem.
 */
export async function pruneWebhookEvents(
  db: SupabaseClient,
  now: number = Date.now()
): Promise<void> {
  const before = (days: number) => new Date(now - days * 86_400_000).toISOString();
  for (const [status, days] of [
    ['done', DONE_RETENTION_DAYS],
    ['failed', FAILED_RETENTION_DAYS],
  ] as const) {
    const { error } = await db
      .from('webhook_events')
      .delete()
      .eq('status', status)
      .lt('created_at', before(days));
    if (error) {
      logEvent('error', 'webhook.prune_failed', { status, error: error.message });
    }
  }
}
