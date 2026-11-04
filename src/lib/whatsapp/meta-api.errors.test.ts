import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadMedia,
  getMediaUrl,
  MetaApiError,
  parseRetryAfterSeconds,
} from './meta-api'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => vi.unstubAllGlobals())

describe('parseRetryAfterSeconds', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterSeconds('120')).toBe(120)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfterSeconds('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30)
  })

  it('floors a date in the past at zero', () => {
    const now = Date.parse('2026-01-01T00:01:00Z')
    expect(parseRetryAfterSeconds('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(0)
  })

  it('returns null for missing or unusable values', () => {
    expect(parseRetryAfterSeconds(null)).toBeNull()
    expect(parseRetryAfterSeconds('soon')).toBeNull()
  })
})

describe('MetaApiError.isMissingObject', () => {
  const err = (
    fields: { code?: number; subcode?: number; httpStatus: number },
    message = 'x',
  ) => new MetaApiError(message, fields)

  it('treats a 404 or 410 as gone', () => {
    expect(err({ httpStatus: 404 }).isMissingObject).toBe(true)
    expect(err({ httpStatus: 410 }).isMissingObject).toBe(true)
  })

  it('treats code 100 with subcode 33 as gone', () => {
    expect(err({ code: 100, subcode: 33, httpStatus: 400 }).isMissingObject).toBe(true)
  })

  it("treats code 100 with Meta's missing-object wording as gone", () => {
    const message = 'Unsupported get request. Object with ID does not exist'
    expect(err({ code: 100, httpStatus: 400 }, message).isMissingObject).toBe(true)
  })

  it('does not treat any other code 100 as gone', () => {
    const message = '(#100) Invalid parameter'
    expect(err({ code: 100, httpStatus: 400 }, message).isMissingObject).toBe(false)
  })

  it('does not treat a token failure as gone', () => {
    expect(err({ code: 190, httpStatus: 401 }).isMissingObject).toBe(false)
  })
})

describe('MetaApiError.isRateLimited', () => {
  it('recognises HTTP 429 and throttling codes sent with other statuses', () => {
    expect(new MetaApiError('x', { httpStatus: 429 }).isRateLimited).toBe(true)
    expect(new MetaApiError('x', { code: 130429, httpStatus: 400 }).isRateLimited).toBe(true)
    expect(new MetaApiError('x', { code: 131000, httpStatus: 500 }).isRateLimited).toBe(false)
  })
})

describe('media read path', () => {
  it('surfaces status and Retry-After when the download is throttled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '42' },
          }),
      ),
    )

    const error = await downloadMedia({
      downloadUrl: 'https://cdn.test/file',
      accessToken: 'token',
    }).catch((e) => e)

    expect(error).toBeInstanceOf(MetaApiError)
    expect(error.httpStatus).toBe(429)
    expect(error.retryAfterSeconds).toBe(42)
    expect(error.isRateLimited).toBe(true)
  })

  it('keeps the existing download failure message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))

    await expect(
      downloadMedia({ downloadUrl: 'https://cdn.test/file', accessToken: 'token' }),
    ).rejects.toThrow('Media download failed: 500')
  })

  it('reports an expired media id as a missing object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(400, {
          error: { message: 'Unsupported get request', code: 100, error_subcode: 33 },
        }),
      ),
    )

    const error = await getMediaUrl({ mediaId: '1', accessToken: 'token' }).catch((e) => e)

    expect(error).toBeInstanceOf(MetaApiError)
    expect(error.isMissingObject).toBe(true)
  })

  it('applies a time limit to both media requests', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('graph.facebook.com')
        ? jsonResponse(200, { url: 'https://cdn.test/file', mime_type: 'image/png' })
        : new Response('bytes'),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getMediaUrl({ mediaId: '1', accessToken: 'token' })
    await downloadMedia({ downloadUrl: 'https://cdn.test/file', accessToken: 'token' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })
})
