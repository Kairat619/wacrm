/**
 * Language, shortcut and placeholder handling for quick replies
 * (migration 066). Pure — shared by the API routes, the settings
 * manager, the inbox picker and the composer's "/" suggestions.
 */

export const QUICK_REPLY_LANGUAGES = ['kk', 'ru'] as const;
export type QuickReplyLanguage = (typeof QUICK_REPLY_LANGUAGES)[number];

/** Matches the CHECK constraint in migration 066. */
export const SHORTCUT_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;

export function normalizeLanguage(value: unknown): QuickReplyLanguage | null {
  return typeof value === 'string' &&
    (QUICK_REPLY_LANGUAGES as readonly string[]).includes(value)
    ? (value as QuickReplyLanguage)
    : null;
}

export type ShortcutResult =
  | { ok: true; value: string | null }
  | { ok: false };

/** Accepts "/price", "price" or "" (clears). Lower-cased, no spaces. */
export function normalizeShortcut(value: unknown): ShortcutResult {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim().replace(/^\/+/, '').toLowerCase();
  if (!trimmed) return { ok: true, value: null };
  return SHORTCUT_PATTERN.test(trimmed)
    ? { ok: true, value: trimmed }
    : { ok: false };
}

export interface PlaceholderValues {
  /** Customer's name. */
  name?: string | null;
  /** Agent's name. */
  agent?: string | null;
}

/**
 * Fill `{{name}}` / `{{agent}}`. A placeholder with no value is removed
 * along with the comma or space before it, so "Сәлеметсіз бе, {{name}}!"
 * becomes "Сәлеметсіз бе!" rather than going out with braces in it.
 */
export function renderPlaceholders(
  text: string,
  values: PlaceholderValues
): string {
  return text.replace(
    /(,\s*|\s)?\{\{\s*(name|agent)\s*\}\}/gi,
    (_match, prefix: string | undefined, key: string) => {
      const value = values[key.toLowerCase() as keyof PlaceholderValues];
      const clean = value?.trim();
      if (!clean) return '';
      return `${prefix ?? ''}${clean}`;
    }
  );
}

export interface FilterableQuickReply {
  title: string;
  content_text?: string | null;
  shortcut?: string | null;
  language?: string | null;
}

/**
 * Search by title, text or shortcut, optionally limited to one language.
 * Replies with no language set show under every language filter.
 */
export function filterQuickReplies<T extends FilterableQuickReply>(
  items: readonly T[],
  query: string,
  language: QuickReplyLanguage | null
): T[] {
  const q = query.trim().replace(/^\//, '').toLowerCase();
  return items.filter((item) => {
    if (language && item.language && item.language !== language) return false;
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) ||
      (item.shortcut ?? '').includes(q) ||
      (item.content_text ?? '').toLowerCase().includes(q)
    );
  });
}

/**
 * When the composer holds just "/something", the replies whose shortcut
 * (or, failing that, title) starts with it. Empty for any other text.
 */
export function shortcutSuggestions<T extends FilterableQuickReply>(
  items: readonly T[],
  draft: string,
  limit = 6
): T[] {
  const m = /^\/([\p{L}\p{N}_-]*)$/u.exec(draft);
  if (!m) return [];
  const q = m[1].toLowerCase();
  const byShortcut = items.filter((i) => i.shortcut && i.shortcut.startsWith(q));
  const byTitle = items.filter(
    (i) => !byShortcut.includes(i) && i.title.toLowerCase().startsWith(q)
  );
  return [...byShortcut, ...byTitle].slice(0, limit);
}
