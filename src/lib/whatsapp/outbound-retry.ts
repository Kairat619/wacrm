import type { SupabaseClient } from '@supabase/supabase-js';

import { logEvent } from '@/lib/observability/log';
import { STUCK_SENDING_SECONDS } from './outbound-state';
import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

interface ClaimedRetry {
  id: string;
  account_id: string;
  send_params: SendMessageParams | null;
  send_attempts: number;
}

/**
 * Send a row that is already in `sending`. A failure before Meta is reached (a
 * removed WhatsApp config, say) would otherwise leave the row stuck, so it is
 * recorded here as needing a person. Meta failures are recorded by the send core.
 */
export async function resendClaimedMessage(
  db: SupabaseClient,
  accountId: string,
  rowId: string,
  params: SendMessageParams,
  attempts: number
): Promise<void> {
  try {
    await sendMessageToConversation(db, accountId, params, {
      existingRowId: rowId,
      attempts,
    });
  } catch (error) {
    if (error instanceof SendMessageError && error.code === 'meta_error') throw error;
    const message = error instanceof Error ? error.message : String(error);
    await db
      .from('messages')
      .update({
        status: 'failed',
        retry_class: 'manual',
        sending_since: null,
        error_title: message,
      })
      .eq('id', rowId)
      .eq('status', 'sending');
    throw error;
  }
}

/** Worker sweep: send what's due, and flag rows whose process died mid-send. */
export async function runOutboundRetries(db: SupabaseClient, limit: number): Promise<number> {
  const { data: flagged, error: flagError } = await db.rpc('flag_stuck_outbound', {
    p_older_than_seconds: STUCK_SENDING_SECONDS,
  });
  if (flagError) {
    logEvent('error', 'outbound.flag_stuck_failed', { error: flagError.message });
  } else if (flagged) {
    logEvent('error', 'outbound.delivery_unknown', { count: flagged });
  }

  const { data, error } = await db.rpc('claim_outbound_retries', { p_limit: limit });
  if (error) {
    logEvent('error', 'outbound.claim_failed', { error: error.message });
    return 0;
  }
  const claimed = (data ?? []) as ClaimedRetry[];
  // One at a time: sends to one customer must keep their order, and speed
  // doesn't matter for a message already being retried.
  for (const row of claimed) {
    if (!row.send_params) continue;
    try {
      await resendClaimedMessage(db, row.account_id, row.id, row.send_params, row.send_attempts);
    } catch (error) {
      logEvent('warn', 'outbound.retry_attempt_failed', {
        message_row_id: row.id,
        attempts: row.send_attempts,
        error,
      });
    }
  }
  return claimed.length;
}
