import { MetaApiError } from './meta-api';

/**
 * What may happen after an outbound failure. Pure, so the policy can be read and
 * tested in one place. The rule behind it: Meta's send endpoint offers no
 * idempotency key, so a resend is only automatic when Meta has clearly told us
 * this attempt did not go out.
 */
export type RetryClass =
  /** The worker retries, within MAX_AUTO_RETRIES. */
  | 'auto'
  /** An agent may retry, usually after fixing something. */
  | 'manual'
  /** Retrying can't help. */
  | 'no_retry'
  /** Meta may have delivered it. Never automatic; a person has to accept the risk. */
  | 'delivery_unknown';

/** Automatic resends per message, on top of the first attempt. */
export const MAX_AUTO_RETRIES = 2;

/** The recipient's engagement limit. Resending only makes things worse. */
export const CODE_ENGAGEMENT_LIMIT = 131049;
/** Meta's generic "something went wrong". */
export const CODE_GENERIC_FAILURE = 131000;

/**
 * Throttling that clears by itself. 131048 (spam rate limit) is left out on
 * purpose: it reflects number quality, and retrying could worsen it.
 */
const THROTTLE_CODES = new Set([4, 80007, 130429, 131056]);
/** Retrying can't change these outcomes. */
const NO_RETRY_CODES = new Set([CODE_ENGAGEMENT_LIMIT]);

function classifyCode(code: number | null): RetryClass {
  if (code === null) return 'manual';
  if (NO_RETRY_CODES.has(code)) return 'no_retry';
  if (code === CODE_GENERIC_FAILURE || THROTTLE_CODES.has(code)) return 'auto';
  return 'manual';
}

/** A failure thrown by the send call itself. */
export function classifySendFailure(error: unknown): RetryClass {
  // A timeout or dropped connection: the request may have got through.
  if (!(error instanceof MetaApiError)) return 'delivery_unknown';
  if (error.httpStatus === 429) return 'auto';
  // A 5xx with no Meta error body proves nothing about whether it was sent.
  if (error.code === null && error.httpStatus >= 500) return 'delivery_unknown';
  return classifyCode(error.code);
}

/** A `failed` status webhook. Meta has stated that this wamid did not arrive. */
export function classifyStatusFailure(code: number | null): RetryClass {
  return classifyCode(code);
}
