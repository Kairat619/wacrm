/**
 * What produced an outbound `messages` row (migration 064). Used to split
 * WhatsApp cost by source: a rep in the inbox, the public API, an
 * automation, a flow, or the AI auto-reply.
 */
export const MESSAGE_ORIGINS = [
  'agent',
  'api',
  'automation',
  'flow',
  'ai',
] as const;

export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

/** Inbox/retry sends carry the rep's id; API sends have none. */
export function defaultSendOrigin(
  senderId: string | null | undefined
): MessageOrigin {
  return senderId ? 'agent' : 'api';
}
