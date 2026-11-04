import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { resendClaimedMessage } from '@/lib/whatsapp/outbound-retry'
import { SendMessageError, type SendMessageParams } from '@/lib/whatsapp/send-message'

/**
 * Manual retry of a failed message from the inbox. It resends the same row, so
 * the thread never shows a second bubble.
 *
 * - `no_retry` (e.g. 131049) is refused: retrying can't help the recipient.
 * - `delivery_unknown` needs `confirm_possible_duplicate`, because Meta may have
 *   already delivered it. That decision is the agent's alone.
 * - The status-guarded update is the claim, so a double click can't send twice.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => ({}))

    const { data: row, error } = await supabase
      .from('messages')
      .select('id, status, retry_class, send_params, send_attempts, conversations!inner(account_id)')
      .eq('id', id)
      .eq('conversations.account_id', accountId)
      .maybeSingle()

    if (error || !row) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }
    if (row.status !== 'failed') {
      return NextResponse.json({ error: 'Only a failed message can be retried' }, { status: 409 })
    }
    if (!row.send_params) {
      return NextResponse.json({ error: 'This message cannot be retried' }, { status: 409 })
    }
    if (row.retry_class === 'no_retry') {
      return NextResponse.json(
        { error: 'Retrying this message would not help', code: 'no_retry' },
        { status: 409 }
      )
    }
    if (row.retry_class === 'delivery_unknown' && body?.confirm_possible_duplicate !== true) {
      return NextResponse.json(
        { error: 'This message may already have been delivered', code: 'confirmation_required' },
        { status: 409 }
      )
    }

    const attempts = (row.send_attempts ?? 0) + 1
    const { data: claimed, error: claimError } = await supabase
      .from('messages')
      .update({
        status: 'sending',
        sending_since: new Date().toISOString(),
        send_attempts: attempts,
        message_id: null,
        next_retry_at: null,
      })
      .eq('id', id)
      .eq('status', 'failed')
      .select('id')

    if (claimError) throw claimError
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({ error: 'Already being retried' }, { status: 409 })
    }

    try {
      await resendClaimedMessage(
        supabase,
        accountId,
        id,
        // The agent retrying becomes the sender of record.
        { ...(row.send_params as SendMessageParams), senderId: userId },
        attempts
      )
      return NextResponse.json({ success: true, message_id: id })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          {
            error: err.message,
            message_id: id,
            retry_class: err.outbound?.retryClass ?? null,
          },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    console.error('Error in message retry POST:', error)
    return toErrorResponse(error)
  }
}
