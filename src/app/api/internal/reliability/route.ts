import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildReliabilityReport } from '@/lib/reliability/metrics'

const DEFAULT_WINDOW_HOURS = 24
const MAX_WINDOW_HOURS = 24 * 30

/**
 * Operator report of delivery, media and queue health across all accounts, so it
 * is protected by the same secret as the cron endpoints rather than a user login.
 * Returns counts only, never message content.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const secret = Buffer.from(expected)
  if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const hours = Number(new URL(request.url).searchParams.get('hours'))
  const windowHours =
    Number.isFinite(hours) && hours > 0
      ? Math.min(hours, MAX_WINDOW_HOURS)
      : DEFAULT_WINDOW_HOURS

  return NextResponse.json(await buildReliabilityReport(supabaseAdmin(), windowHours))
}
