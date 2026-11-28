/**
 * Cost nudges for the composer. Since 2026-10-01 every outbound service
 * reply past the first 1,000 a month is billed, so five short messages
 * cost five times one complete one. These helpers only inform the rep;
 * nothing here ever blocks a send.
 */

export interface NudgeMessage {
  sender_type: string;
  content_text?: string | null;
  created_at: string;
  status?: string | null;
}

/** Back-to-back window, matching the cost page's "burst" definition. */
export const BURST_WINDOW_MS = 60_000;
/** How far back a repeated text counts as a duplicate. */
export const DUPLICATE_WINDOW_MS = 24 * 3_600_000;
const DUPLICATE_LOOKBACK = 10;

export function normalizeForDuplicate(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isOutbound(m: NudgeMessage): boolean {
  return m.sender_type !== 'customer' && m.status !== 'failed';
}

/**
 * The earlier outbound message with the same text, within the last day
 * and the last few outbound messages, or null. Texts of three characters
 * or fewer ("ok", "+") never count.
 */
export function findDuplicateSend(
  text: string,
  messages: readonly NudgeMessage[],
  now: number
): NudgeMessage | null {
  const target = normalizeForDuplicate(text);
  if (target.length <= 3) return null;
  const outbound = messages.filter(isOutbound).slice(-DUPLICATE_LOOKBACK);
  for (let i = outbound.length - 1; i >= 0; i--) {
    const m = outbound[i];
    const at = Date.parse(m.created_at);
    if (!Number.isFinite(at) || now - at > DUPLICATE_WINDOW_MS) continue;
    if (normalizeForDuplicate(m.content_text ?? '') === target) return m;
  }
  return null;
}

/**
 * Outbound messages sent in a row since the customer last wrote, where
 * each followed the previous within the burst window and the latest is
 * still inside it. 0 when the customer spoke last or the rep paused.
 */
export function currentBurstLength(
  messages: readonly NudgeMessage[],
  now: number
): number {
  let count = 0;
  let next = now;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender_type === 'customer') break;
    if (!isOutbound(m)) continue;
    const at = Date.parse(m.created_at);
    if (!Number.isFinite(at) || next - at > BURST_WINDOW_MS) break;
    count++;
    next = at;
  }
  return count;
}
