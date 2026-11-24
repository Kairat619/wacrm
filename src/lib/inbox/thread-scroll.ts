import type { Message } from "@/types";

/** How close to the bottom (px) still counts as reading the latest messages. */
export const BOTTOM_THRESHOLD_PX = 64;

interface ScrollMetrics {
  scrollTop: number;
  previousScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether the thread should keep following new messages after a scroll event.
 *
 * Only moving upward stops following. Distance alone isn't enough: an image
 * that loads between a scroll and its event makes the content taller, which
 * would look like the agent had scrolled away.
 */
export function shouldFollowLatest(
  wasFollowing: boolean,
  { scrollTop, previousScrollTop, scrollHeight, clientHeight }: ScrollMetrics,
): boolean {
  const distance = scrollHeight - clientHeight - scrollTop;
  if (distance <= BOTTOM_THRESHOLD_PX) return true;
  if (scrollTop < previousScrollTop) return false;
  return wasFollowing;
}

export function lastCustomerMessageId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].sender_type === "customer") return messages[i].id;
  }
  return null;
}

/**
 * Customer messages after `afterId`, or all of them when it is null (there
 * were none yet). Returns 0 when that message is no longer loaded.
 */
export function countCustomerMessagesAfter(
  messages: Message[],
  afterId: string | null,
): number {
  let start = 0;
  if (afterId !== null) {
    const index = messages.findIndex((m) => m.id === afterId);
    if (index < 0) return 0;
    start = index + 1;
  }
  return messages.slice(start).filter((m) => m.sender_type === "customer")
    .length;
}
