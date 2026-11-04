/**
 * Keeps an unsent message across a forced trip to the login page. Tab-scoped, so
 * it disappears with the tab rather than lingering on a shared computer.
 * Storage can be unavailable (private windows, blocked site data), which must
 * never get in the way of typing, so failures are ignored.
 */
const KEY_PREFIX = 'wacrm-composer-draft:';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): DraftStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadDraft(
  conversationId: string,
  storage: DraftStorage | null = defaultStorage()
): string {
  try {
    return storage?.getItem(KEY_PREFIX + conversationId) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(
  conversationId: string,
  text: string,
  storage: DraftStorage | null = defaultStorage()
): void {
  try {
    if (text) storage?.setItem(KEY_PREFIX + conversationId, text);
    else storage?.removeItem(KEY_PREFIX + conversationId);
  } catch {
    // Storage is full or blocked; the draft just won't survive a redirect.
  }
}
