import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from '@/i18n/routing';
import { locales, type Locale } from '@/i18n/config';
import { shareSessionCheck } from '@/lib/auth/session-single-flight';
import { logEvent } from '@/lib/observability/log';

const handleI18nRouting = createMiddleware(routing);

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // Parallel requests holding the same session share one check, so they can't
  // each try to rotate the same refresh token. See session-single-flight.ts.
  const authCookies = request.cookies
    .getAll()
    .filter(({ name }) => name.includes('-auth-token'))
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');

  const {
    user,
    error: authError,
    cookies: rotatedCookies,
  } = await shareSessionCheck(authCookies, async () => {
    const written: {
      name: string;
      value: string;
      options?: Record<string, unknown>;
    }[] = [];
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            written.push(...cookiesToSet);
          },
        },
      }
    );
    const { data, error } = await supabase.auth.getUser();
    return { user: data.user, error, cookies: written };
  });

  if (rotatedCookies.length > 0) {
    rotatedCookies.forEach(({ name, value }) =>
      request.cookies.set(name, value)
    );
    supabaseResponse = NextResponse.next({ request });
    rotatedCookies.forEach(({ name, value, options }) =>
      supabaseResponse.cookies.set(name, value, options)
    );
  }

  // A network failure or 5xx from Supabase says nothing about the session,
  // and auth-js keeps the cookies in that case. Treating it as "logged out"
  // would send a signed-in user to /login over a momentary blip.
  const authUnavailable = !user && isAuthRetryableFetchError(authError);

  // A session that existed and could not be renewed. Counted through this log
  // event, because it never reaches the database.
  const sessionLost = !user && !authUnavailable && !!authCookies && !!authError;
  if (sessionLost) {
    logEvent('warn', 'auth.refresh_failed', {
      code: (authError as { code?: string }).code ?? null,
    });
  }

  // Copy refreshed cookies onto whatever response we return to prevent
  // session wedge after token rotation (issue #288).
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie);
    });
    return response;
  };

  // --- Auth page redirects (locale-aware) ---
  // Match /{locale}/login, /{locale}/signup, /{locale}/forgot-password
  const authPageRegex = /^\/[a-z]{2}(?:\/(login|signup|forgot-password))?$/;
  const authPageMatch = request.nextUrl.pathname.match(authPageRegex);

  // Also match bare /login, /signup, /forgot-password (no locale prefix)
  // so direct hits from old bookmarks still work.
  const bareAuthPaths = ['/login', '/signup', '/forgot-password'];
  const isAuthPage =
    bareAuthPaths.includes(request.nextUrl.pathname) ||
    (authPageMatch && authPageMatch[1]);

  if (user && isAuthPage) {
    const url = request.nextUrl.clone();
    // Preserve the locale prefix if present
    const localeMatch = request.nextUrl.pathname.match(/^\/([a-z]{2})\//);
    const localePrefix = localeMatch ? `/${localeMatch[1]}` : '';

    const inviteToken = request.nextUrl.searchParams.get('invite');
    if (
      inviteToken &&
      (request.nextUrl.pathname.includes('/login') ||
        request.nextUrl.pathname.includes('/signup'))
    ) {
      url.pathname = `${localePrefix}/join/${encodeURIComponent(inviteToken)}`;
      url.search = '';
    } else {
      url.pathname = `${localePrefix}/dashboard`;
      url.search = '';
    }
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // --- Protected pages ---
  const protectedSegments = [
    'dashboard',
    'inbox',
    'notifications',
    'contacts',
    'pipelines',
    'broadcasts',
    'automations',
    'flows',
    'agents',
    'settings',
  ];
  const isProtectedPage = protectedSegments.some(
    (segment) =>
      request.nextUrl.pathname.includes(`/${segment}`) ||
      request.nextUrl.pathname === `/${segment}`
  );

  if (!user && !authUnavailable && isProtectedPage) {
    const url = request.nextUrl.clone();
    // Try to preserve locale prefix
    const localeMatch = request.nextUrl.pathname.match(/^\/([a-z]{2})\//);
    const localePrefix = localeMatch ? `/${localeMatch[1]}` : '';
    url.pathname = `${localePrefix}/login`;
    if (sessionLost) {
      // Say why, and return them to where they were once they've signed in.
      url.search = '';
      url.searchParams.set('reason', 'session_expired');
      url.searchParams.set('next', request.nextUrl.pathname);
    }
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // --- API routes that need auth (not webhooks) ---
  if (
    authUnavailable &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withRefreshedCookies(
      NextResponse.json(
        { error: 'Authentication service unavailable' },
        { status: 503, headers: { 'Retry-After': '5' } }
      )
    );
  }

  if (
    !user &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );
  }

  // --- API routes must NEVER be locale-prefixed ---
  // next-intl uses localePrefix "always" by default, so handing an
  // /api/* path to handleI18nRouting makes it 307-redirect to
  // /{locale}/api/... — which has no matching route handler and 404s
  // with an HTML error page. The client then chokes on the HTML with
  // "Unexpected token '<' ... is not valid JSON", and Meta's webhook
  // verification (a bare GET to /api/whatsapp/webhook) fails because
  // the challenge request gets redirected away from the handler.
  // Skip i18n entirely for API routes and return the Supabase response
  // (with any refreshed session cookies) directly.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return supabaseResponse;
  }

  // --- Supabase auth callback must NEVER be locale-prefixed ---
  // The `/auth/callback` route handler performs the PKCE code exchange for
  // email confirmation / password recovery. Its base URL is the Supabase
  // project "Site URL", which carries no locale prefix. Handing it to
  // next-intl would 307-redirect to /{locale}/auth/callback (no matching
  // handler → 404) and drop the one-time `?code=`. Skip i18n and let the
  // route handler run, returning any refreshed session cookies.
  if (request.nextUrl.pathname.startsWith('/auth/')) {
    return supabaseResponse;
  }

  // --- i18n routing via next-intl ---
  // The next-intl middleware is REQUIRED — createNextIntlPlugin depends on
  // the locale context it sets up (cookies / headers).  Without it,
  // requestLocale in getRequestConfig is always undefined and messages
  // always load in the default language.
  const i18nResponse = handleI18nRouting(request);

  if (i18nResponse) {
    // Safety net: intercept any double-locale-prefix redirect the
    // next-intl middleware might emit (e.g. /kk/kk/dashboard → /kk/dashboard).
    if (i18nResponse.status >= 300 && i18nResponse.status < 400) {
      const location = i18nResponse.headers.get('Location');
      if (location) {
        const locUrl = new URL(location, request.url);
        const parts = locUrl.pathname.split('/');
        if (
          parts.length >= 4 &&
          locales.includes(parts[1] as Locale) &&
          locales.includes(parts[2] as Locale)
        ) {
          locUrl.pathname = `/${parts[1]}/${parts.slice(3).join('/')}`;
          return withRefreshedCookies(
            NextResponse.redirect(locUrl.toString(), i18nResponse.status)
          );
        }
      }
    }

    // Copy Supabase cookies onto the i18n response and return it
    // (not supabaseResponse) so the locale context propagates.
    return withRefreshedCookies(i18nResponse);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Match all paths except static assets and API internals
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
