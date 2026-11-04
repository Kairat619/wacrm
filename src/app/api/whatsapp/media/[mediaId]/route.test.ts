import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  accountId: 'acc-1' as string | null,
  downloadContentType: 'image/jpeg',
  metaMimeType: 'image/jpeg',
  rateLimitOk: true,
  downloadError: null as Error | null,
  metaCalls: 0,
  job: null as { status: string; storage_key: string | null; content_type: string | null } | null,
  object: null as {
    body: ReadableStream<Uint8Array>
    contentType: string | null
    status?: number
    contentLength?: string | null
    contentRange?: string | null
  } | null,
  storageRange: undefined as string | null | undefined,
  storageError: null as Error | null,
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/media-jobs/queue', () => ({
  findMediaJob: async () => h.job,
}))
vi.mock('@/lib/media-jobs/r2-storage', () => ({
  mediaStorageFromEnv: () => ({
    get: async (_key: string, options?: { range?: string | null }) => {
      h.storageRange = options?.range
      if (h.storageError) throw h.storageError
      return h.object
    },
  }),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      }),
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user }, error: null }),
    },
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === 'profiles' && h.accountId ? { account_id: h.accountId } : null,
        }),
        single: async () => ({
          data: table === 'whatsapp_config' ? { access_token: 'enc-token' } : null,
          error: null,
        }),
      }
      return chain
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => `plain-${value}`,
}))

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { whatsappMedia: { limit: 240, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: h.rateLimitOk }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  MetaApiError: (await importOriginal<typeof import('@/lib/whatsapp/meta-api')>())
    .MetaApiError,
  getMediaUrl: async () => {
    h.metaCalls++
    return {
      url: 'https://lookaside.example/media',
      mimeType: h.metaMimeType,
      fileSize: 3,
    }
  },
  downloadMedia: async () => {
    if (h.downloadError) throw h.downloadError
    return {
      buffer: Buffer.from('abc'),
      contentType: h.downloadContentType,
    }
  },
}))

import { GET } from './route'
import { MetaApiError } from '@/lib/whatsapp/meta-api'

function call(mediaId = '1234567890') {
  return GET(new Request(`http://localhost/api/whatsapp/media/${mediaId}`), {
    params: Promise.resolve({ mediaId }),
  })
}

beforeEach(() => {
  h.user = { id: 'user-1' }
  h.accountId = 'acc-1'
  h.downloadContentType = 'image/jpeg'
  h.metaMimeType = 'image/jpeg'
  h.rateLimitOk = true
  h.downloadError = null
  h.metaCalls = 0
  h.job = null
  h.object = null
  h.storageError = null
  h.storageRange = undefined
  delete process.env.MEDIA_JOBS_ENABLED
})

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('serves an image inline with the hardening headers', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(await res.text()).toBe('abc')
  })

  it('forces a customer-sent HTML document to download', async () => {
    h.downloadContentType = 'text/html; charset=utf-8'
    h.metaMimeType = 'text/html'
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  })

  it('forces an SVG image to download', async () => {
    h.downloadContentType = 'image/svg+xml'
    const res = await call()
    expect(res.headers.get('content-disposition')).toBe('attachment')
  })

  it('names a PDF download after the media id', async () => {
    h.downloadContentType = 'application/pdf'
    const res = await call('42')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="42.pdf"')
  })

  it('never lets a shared cache store the response', async () => {
    const res = await call()
    const cacheControl = res.headers.get('cache-control') ?? ''
    expect(cacheControl).toBe('private, max-age=86400')
    expect(cacheControl).not.toContain('public')
  })

  it('rejects an unauthenticated caller before touching Meta', async () => {
    h.user = null
    const res = await call()
    expect(res.status).toBe(401)
  })

  it('rejects a caller with no linked account', async () => {
    h.accountId = null
    const res = await call()
    expect(res.status).toBe(403)
  })

  it('passes Meta throttling through as 429 with Retry-After', async () => {
    h.downloadError = new MetaApiError('Media download failed: 429', {
      httpStatus: 429,
      retryAfterSeconds: 42,
    })
    const res = await call()
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
  })

  it('reports media Meta no longer holds as 410', async () => {
    h.downloadError = new MetaApiError('gone', { httpStatus: 404 })
    const res = await call()
    expect(res.status).toBe(410)
  })

  it('does not report an unrelated Meta parameter error as expired', async () => {
    h.downloadError = new MetaApiError('(#100) Invalid parameter', {
      code: 100,
      httpStatus: 400,
    })
    const res = await call()
    expect(res.status).toBe(500)
  })

  describe('with media jobs on', () => {
    const bytes = () => new Response('r2-bytes').body as ReadableStream<Uint8Array>

    beforeEach(() => {
      process.env.MEDIA_JOBS_ENABLED = 'true'
    })

    it('serves a stored file from R2 without calling Meta', async () => {
      h.job = { status: 'stored', storage_key: 'k', content_type: 'image/png' }
      h.object = { body: bytes(), contentType: 'image/png', status: 200 }

      const res = await call()

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('r2-bytes')
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(h.metaCalls).toBe(0)
    })

    it('honours a range request, which video playback depends on', async () => {
      h.job = { status: 'stored', storage_key: 'k', content_type: 'video/mp4' }
      h.object = {
        body: bytes(),
        contentType: 'video/mp4',
        status: 206,
        contentLength: '8',
        contentRange: 'bytes 0-7/100',
      }

      const res = await GET(
        new Request('http://localhost/api/whatsapp/media/1', {
          headers: { range: 'bytes=0-7' },
        }),
        { params: Promise.resolve({ mediaId: '1' }) },
      )

      expect(h.storageRange).toBe('bytes=0-7')
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 0-7/100')
      expect(res.headers.get('content-length')).toBe('8')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
    })

    it('still requires a signed-in caller before serving from R2', async () => {
      h.user = null
      h.job = { status: 'stored', storage_key: 'k', content_type: 'image/png' }
      h.object = { body: bytes(), contentType: 'image/png', status: 200 }

      expect((await call()).status).toBe(401)
    })

    it('answers 410 for unavailable media without calling Meta', async () => {
      h.job = { status: 'unavailable', storage_key: null, content_type: null }

      expect((await call()).status).toBe(410)
      expect(h.metaCalls).toBe(0)
    })

    it('falls back to Meta while the job is still running', async () => {
      h.job = { status: 'downloading', storage_key: null, content_type: null }

      const res = await call()

      expect(await res.text()).toBe('abc')
      expect(h.metaCalls).toBe(1)
    })

    it('falls back to Meta when R2 cannot be read', async () => {
      h.job = { status: 'stored', storage_key: 'k', content_type: 'image/png' }
      h.storageError = new Error('R2 read failed: 500')
      vi.spyOn(console, 'warn').mockImplementationOnce(() => {})

      const res = await call()

      expect(await res.text()).toBe('abc')
    })
  })
})
