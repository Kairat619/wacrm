/**
 * Exponential backoff with full jitter: a random wait between zero and the
 * exponential ceiling, so jobs that failed together don't all return together.
 * A `Retry-After` from the server sets the minimum wait.
 */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Seconds the server asked us to wait, if it said. */
  retryAfterSeconds?: number | null;
  /** Injected in tests. */
  random?: () => number;
}

export function backoffDelayMs(
  attempt: number,
  { baseMs, maxMs, retryAfterSeconds, random = Math.random }: BackoffOptions
): number {
  const exponent = Math.max(0, attempt - 1);
  // Bounded before Math.pow so a large attempt can't overflow to Infinity.
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(exponent, 30));
  const jittered = Math.floor(random() * ceiling);
  const floor = (retryAfterSeconds ?? 0) * 1000;
  return Math.max(jittered, floor);
}
