import type { SupabaseClient } from '@supabase/supabase-js';

import { logEvent } from '@/lib/observability/log';
import { backoffDelayMs } from '@/lib/reliability/backoff';
import { MetaApiError } from './meta-api';
import {
  classifySendFailure,
  classifyStatusFailure,
  CODE_ENGAGEMENT_LIMIT,
  CODE_GENERIC_FAILURE,
  MAX_AUTO_RETRIES,
  type RetryClass,
} from './outbound-failure';

/** The outbound row's lifecycle (migration 063). See that file for the states. */

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** Longer than a send call can take, so only a dead process leaves a row here. */
export const STUCK_SENDING_SECONDS = 5 * 60;

export type BeginResult =
  | { kind: 'new'; id: string }
  | {
      kind: 'duplicate';
      id: string;
      status: string;
      whatsappMessageId: string | null;
      retryClass: RetryClass | null;
    };

/**
 * Save the row and move it to `sending`. A request id seen before returns the
 * existing row, which is what stops a repeated request sending twice.
 */
export async function beginOutboundMessage(
  db: SupabaseClient,
  fields: Record<string, unknown>,
  clientRequestId: string | null,
  sendParams: unknown,
  now: number = Date.now()
): Promise<BeginResult> {
  const { data, error } = await db
    .from('messages')
    .upsert(
      {
        ...fields,
        status: 'queued',
        client_request_id: clientRequestId,
        send_params: sendParams,
        send_attempts: 1,
      },
      { onConflict: 'conversation_id,client_request_id', ignoreDuplicates: true }
    )
    .select('id');
  if (error) throw new Error(`saving outbound message failed: ${error.message}`);

  if (!data || data.length === 0) {
    const { data: existing, error: lookupError } = await db
      .from('messages')
      .select('id, status, message_id, retry_class')
      .eq('conversation_id', fields.conversation_id as string)
      .eq('client_request_id', clientRequestId as string)
      .single();
    if (lookupError || !existing) {
      throw new Error(`reading duplicate message failed: ${lookupError?.message}`);
    }
    return {
      kind: 'duplicate',
      id: existing.id,
      status: existing.status,
      whatsappMessageId: existing.message_id,
      retryClass: existing.retry_class,
    };
  }

  const id = data[0].id as string;
  const { error: claimError } = await db
    .from('messages')
    .update({ status: 'sending', sending_since: new Date(now).toISOString() })
    .eq('id', id)
    .eq('status', 'queued');
  if (claimError) throw new Error(`claiming outbound message failed: ${claimError.message}`);
  return { kind: 'new', id };
}

/**
 * Record Meta's acceptance. A database failure here does not throw: the message
 * has gone out, and reporting failure would invite an agent to send it again.
 * The row stays `sending` and is later flagged as delivery_unknown.
 */
export async function completeOutboundMessage(
  db: SupabaseClient,
  id: string,
  whatsappMessageId: string
): Promise<void> {
  const { error } = await db
    .from('messages')
    .update({
      status: 'sent',
      message_id: whatsappMessageId,
      sending_since: null,
      next_retry_at: null,
      retry_class: null,
      error_code: null,
      error_title: null,
      error_details: null,
      error_http_status: null,
      error_subcode: null,
      error_fbtrace_id: null,
    })
    .eq('id', id)
    .eq('status', 'sending');
  if (error) {
    logEvent('error', 'outbound.complete_failed', { message_row_id: id, error: error.message });
  }
}

/** Limits a class to what the attempt count still allows. */
function withinRetryBudget(retryClass: RetryClass, attempts: number): RetryClass {
  return retryClass === 'auto' && attempts > MAX_AUTO_RETRIES ? 'manual' : retryClass;
}

function retryAt(attempts: number, retryAfterSeconds: number | null, now: number, random?: () => number) {
  return new Date(
    now +
      backoffDelayMs(attempts, {
        baseMs: RETRY_BASE_MS,
        maxMs: RETRY_MAX_MS,
        retryAfterSeconds,
        random,
      })
  ).toISOString();
}

function logFailure(
  id: string,
  retryClass: RetryClass,
  rawClass: RetryClass,
  attempts: number,
  details: Record<string, unknown>
) {
  const code = details.code;
  // Separate event names, so each can be counted in the logs on its own.
  if (code === CODE_ENGAGEMENT_LIMIT) {
    logEvent('warn', 'outbound.engagement_limit', { message_row_id: id, ...details });
  } else if (code === CODE_GENERIC_FAILURE) {
    logEvent('warn', 'outbound.generic_failure', { message_row_id: id, attempts, ...details });
  }
  // Retries used up: a person needs to look at this.
  const exhausted = rawClass === 'auto' && retryClass === 'manual';
  logEvent(exhausted ? 'error' : 'warn', exhausted ? 'outbound.retries_exhausted' : 'outbound.failed', {
    message_row_id: id,
    retry_class: retryClass,
    attempts,
    ...details,
  });
}

export interface FailureOutcome {
  status: 'queued' | 'failed';
  retryClass: RetryClass;
}

/**
 * Record a failed send call. An automatic retry goes back to `queued` with a due
 * time; anything else ends at `failed`.
 */
export async function failOutboundMessage(
  db: SupabaseClient,
  id: string,
  error: unknown,
  attempts: number,
  now: number = Date.now(),
  random?: () => number
): Promise<FailureOutcome> {
  const rawClass = classifySendFailure(error);
  const retryClass = withinRetryBudget(rawClass, attempts);
  const isMeta = error instanceof MetaApiError;
  const status = retryClass === 'auto' ? 'queued' : 'failed';

  const { error: updateError } = await db
    .from('messages')
    .update({
      status,
      retry_class: retryClass,
      sending_since: null,
      next_retry_at:
        retryClass === 'auto'
          ? retryAt(attempts, isMeta ? error.retryAfterSeconds : null, now, random)
          : null,
      error_code: isMeta ? error.code : null,
      error_title:
        retryClass === 'delivery_unknown'
          ? 'Delivery unknown'
          : error instanceof Error
            ? error.message
            : String(error),
      error_details: isMeta ? error.details : null,
      error_http_status: isMeta ? error.httpStatus : null,
      error_subcode: isMeta ? error.subcode : null,
      error_fbtrace_id: isMeta ? error.fbtraceId : null,
    })
    .eq('id', id)
    .eq('status', 'sending');
  if (updateError) {
    logEvent('error', 'outbound.fail_record_failed', { message_row_id: id, error: updateError.message });
  }

  logFailure(id, retryClass, rawClass, attempts, {
    http_status: isMeta ? error.httpStatus : null,
    code: isMeta ? error.code : null,
    subcode: isMeta ? error.subcode : null,
    fbtrace_id: isMeta ? error.fbtraceId : null,
  });
  return { status, retryClass };
}

/**
 * After a `failed` status webhook has been applied, decide what happens next.
 * Only rows saved by the persist-first path carry `send_params`; other send paths
 * are left exactly as the webhook left them.
 *
 * A retry clears the old wamid, so a late status for that attempt can no longer
 * touch this row.
 */
export async function handleStatusFailure(
  db: SupabaseClient,
  rowIds: string[],
  failureCode: number | null,
  now: number = Date.now(),
  random?: () => number
): Promise<void> {
  if (rowIds.length === 0) return;
  const { data, error } = await db
    .from('messages')
    .select('id, send_attempts, send_params')
    .in('id', rowIds)
    .eq('status', 'failed');
  if (error) {
    logEvent('error', 'outbound.status_failure_lookup_failed', { error: error.message });
    return;
  }

  for (const row of data ?? []) {
    if (!row.send_params) {
      // Not retryable from here, but the counts should still include it.
      logFailure(row.id, 'manual', 'manual', row.send_attempts, { code: failureCode });
      continue;
    }
    const rawClass = classifyStatusFailure(failureCode);
    const retryClass = withinRetryBudget(rawClass, row.send_attempts);
    const retrying = retryClass === 'auto';
    const { error: updateError } = await db
      .from('messages')
      .update({
        retry_class: retryClass,
        ...(retrying
          ? {
              status: 'queued',
              message_id: null,
              next_retry_at: retryAt(row.send_attempts, null, now, random),
            }
          : {}),
      })
      .eq('id', row.id)
      .eq('status', 'failed');
    if (updateError) {
      logEvent('error', 'outbound.status_failure_update_failed', {
        message_row_id: row.id,
        error: updateError.message,
      });
    }
    logFailure(row.id, retryClass, rawClass, row.send_attempts, { code: failureCode });
  }
}
