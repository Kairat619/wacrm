import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { getPricingAnalytics, getWabaCurrency } from '@/lib/whatsapp/meta-api';
import { defaultSyncWindow, toBillingRows } from './rows';

export interface BillingSyncResult {
  rows: number;
  start: string;
  end: string;
}

export class BillingSyncError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/**
 * Pull Meta's pricing_analytics for the account's WABA and upsert it into
 * `whatsapp_billing_daily`. Re-running is safe: rows are keyed on their
 * dimensions and today's partial numbers are simply overwritten.
 *
 * `db` must be a service-role client (the table has no write policy).
 */
export async function syncBillingForAccount(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date()
): Promise<BillingSyncResult> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('waba_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new BillingSyncError(error.message, 500);
  if (!config?.waba_id || !config.access_token) {
    throw new BillingSyncError('WhatsApp is not connected', 409);
  }

  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token);
  } catch {
    throw new BillingSyncError('Stored WhatsApp token cannot be read', 409);
  }

  const window = defaultSyncWindow(now);
  const [points, currency] = await Promise.all([
    getPricingAnalytics({
      wabaId: config.waba_id,
      accessToken,
      start: window.start,
      end: window.end,
    }),
    getWabaCurrency({ wabaId: config.waba_id, accessToken }),
  ]);

  const rows = toBillingRows(points, {
    accountId,
    wabaId: config.waba_id,
    currency,
    fetchedAt: now.toISOString(),
  });
  if (rows.length > 0) {
    const { error: upsertError } = await db
      .from('whatsapp_billing_daily')
      .upsert(rows, {
        onConflict:
          'account_id,waba_id,day,pricing_category,pricing_type,country',
      });
    if (upsertError) throw new BillingSyncError(upsertError.message, 500);
  }

  return {
    rows: rows.length,
    start: new Date(window.start * 1000).toISOString(),
    end: new Date(window.end * 1000).toISOString(),
  };
}
