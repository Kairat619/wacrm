import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { BillingSyncError, syncBillingForAccount } from '@/lib/billing/sync';

/**
 * Pull Meta's pricing analytics (this month and last) into
 * `whatsapp_billing_daily`. Admin-only; the cost page calls it on load
 * when the snapshot is stale and from its "Sync now" button. Meta keeps
 * the history, so on-demand syncing loses nothing.
 */
export async function POST() {
  let accountId: string;
  try {
    ({ accountId } = await requireRole('admin'));
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    const result = await syncBillingForAccount(supabaseAdmin(), accountId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BillingSyncError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[billing/sync] failed:', err);
    const message = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
