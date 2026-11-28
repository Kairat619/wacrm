import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

/**
 * Record the Meta invoice for a month so the cost page can show the gap
 * between Meta's analytics and what was actually billed (tax, FX, credits).
 * Body: { month: "YYYY-MM", amount: number, currency?: string, note?: string }.
 * An amount of null deletes the month's entry.
 */
export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const month = typeof body?.month === 'string' ? body.month : '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json(
      { error: 'month must be YYYY-MM' },
      { status: 400 }
    );
  }
  const monthDate = `${month}-01`;

  if (body.amount === null) {
    const { error } = await ctx.supabase
      .from('whatsapp_invoices')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('month', monthDate);
    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
    return NextResponse.json(
      { error: 'amount must be a positive number' },
      { status: 400 }
    );
  }
  const currency =
    typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)
      ? body.currency
      : 'USD';
  const note =
    typeof body.note === 'string' && body.note.trim()
      ? body.note.trim().slice(0, 500)
      : null;

  // RLS (whatsapp_invoices_* policies) requires admin on the account.
  const { error } = await ctx.supabase.from('whatsapp_invoices').upsert(
    {
      account_id: ctx.accountId,
      month: monthDate,
      amount: Math.round(amount * 100) / 100,
      currency,
      note,
      created_by: ctx.userId,
    },
    { onConflict: 'account_id,month' }
  );
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
