import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia, MetaApiError } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findMediaJob } from '@/lib/media-jobs/queue'
import { mediaStorageFromEnv } from '@/lib/media-jobs/r2-storage'
import { logEvent } from '@/lib/observability/log'
import { mediaJobsEnabled } from '@/lib/reliability/flags'

const t = getT('Api')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      )
    }

    const limit = checkRateLimit(`whatsapp-media:${user.id}`, RATE_LIMITS.whatsappMedia)
    if (!limit.success) return rateLimitResponse(limit)

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: t('common.profileNotLinked') },
        { status: 403 },
      )
    }

    // Our own copy first: it needs no Meta call and outlives Meta's retention.
    if (mediaJobsEnabled()) {
      const stored = await serveFromStorage(accountId, mediaId)
      if (stored) return stored
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
    })
  } catch (error) {
    // Meta deletes inbound media ~30 days after receipt, so a pointer
    // stored before the inbound mirror shipped (issue #466) eventually
    // resolves to nothing. That is expected end-of-life, not a server
    // fault: 410 tells the bubble to render "unavailable", and a single
    // warn line keeps a decade-old thread from filling the logs with
    // stack traces every time an agent scrolls past it.
    if (error instanceof MetaApiError && error.isMissingObject) {
      const { mediaId } = await params
      console.warn(
        `[whatsapp/media] ${mediaId} is no longer available from Meta ` +
          `(code ${error.code ?? '?'}/${error.subcode ?? '?'})`
      )
      return NextResponse.json(
        {
          error: 'This attachment is no longer available.',
          code: 'media_expired',
        },
        { status: 410 }
      )
    }
    // Pass Meta's throttling through so the caller can back off, rather
    // than reporting it as a server fault.
    if (error instanceof MetaApiError && error.isRateLimited) {
      console.warn(`[whatsapp/media] rate limited by Meta (code ${error.code ?? '?'})`)
      return NextResponse.json(
        { error: t('media.fetchFailed'), code: 'media_rate_limited' },
        {
          status: 429,
          headers: { 'Retry-After': String(error.retryAfterSeconds ?? 30) },
        },
      )
    }
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}

/**
 * The response for a media job that has reached a final state, or null to fall
 * through to Meta. Any failure here falls through too, because Meta may well
 * still have the file.
 */
async function serveFromStorage(
  accountId: string,
  mediaId: string
): Promise<Response | null> {
  try {
    const job = await findMediaJob(supabaseAdmin(), accountId, mediaId)
    if (job?.status === 'unavailable') {
      return NextResponse.json(
        { error: 'This attachment is no longer available.', code: 'media_expired' },
        { status: 410 }
      )
    }
    if (job?.status !== 'stored' || !job.storage_key) return null
    const object = await mediaStorageFromEnv()?.get(job.storage_key)
    if (!object) return null
    return new Response(object.body, {
      status: 200,
      headers: mediaProxyHeaders(
        mediaId,
        job.content_type ?? object.contentType ?? 'application/octet-stream'
      ),
    })
  } catch (error) {
    logEvent('warn', 'media.storage_read_failed', { media_id: mediaId, error })
    return null
  }
}
