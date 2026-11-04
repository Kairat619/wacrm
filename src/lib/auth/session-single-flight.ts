/**
 * Stops parallel requests from each rotating the same refresh token.
 *
 * auth-js shares a refresh within one browser tab, but the middleware builds a
 * fresh client per request. A thread full of images fires many requests at once,
 * so when the access token has expired they could all present one refresh token.
 * Supabase rotates it on first use, and past its reuse grace period a later use
 * fails with `refresh_token_not_found`.
 *
 * So requests carrying identical auth cookies share one check. A check that
 * rotated the tokens is also remembered briefly, for requests the browser sent
 * with the old cookie before it received the new one.
 *
 * In-memory, so this protects one server process. Enough at one replica; running
 * more would need this state shared between them.
 */

export interface SessionCheck<TUser, TError> {
  user: TUser | null;
  error: TError | null;
  /** Cookies the check wants written; non-empty when the tokens rotated. */
  cookies: { name: string; value: string; options?: Record<string, unknown> }[];
}

/** Long enough to cover requests already in flight when the tokens rotated. */
export const ROTATED_RESULT_TTL_MS = 10_000;

const entries = new Map<string, Promise<SessionCheck<unknown, unknown>>>();

export function shareSessionCheck<TUser, TError>(
  authCookies: string,
  check: () => Promise<SessionCheck<TUser, TError>>,
  ttlMs: number = ROTATED_RESULT_TTL_MS
): Promise<SessionCheck<TUser, TError>> {
  // No session to refresh, so nothing to protect and no network call to share.
  if (!authCookies) return check();

  const existing = entries.get(authCookies);
  if (existing) return existing as Promise<SessionCheck<TUser, TError>>;

  const running = check();
  entries.set(authCookies, running);
  const forget = () => {
    entries.delete(authCookies);
  };
  running.then((result) => {
    if (result.cookies.length > 0 && result.user) {
      setTimeout(forget, ttlMs);
    } else {
      forget();
    }
  }, forget);
  return running;
}

/** Test helper: clear the shared state between cases. */
export function __resetSessionChecksForTests(): void {
  entries.clear();
}
