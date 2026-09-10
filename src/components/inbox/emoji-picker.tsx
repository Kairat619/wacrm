'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  EMOJI_CATEGORIES,
  searchEmojis,
  type EmojiCategoryId,
} from '@/lib/emoji/emoji-data';

/** Per-browser MRU list so an agent's go-to emoji stay one click away. */
const RECENT_KEY = 'wacrm:composer:recent-emoji';
const RECENT_MAX = 24;

function readRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Corrupt/blocked storage — recents are a convenience, not state.
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private mode / quota — silently skip, the picker still works.
  }
}

interface EmojiPickerProps {
  /** Called with the chosen glyph; the composer inserts it at the caret. */
  onSelect: (emoji: string) => void;
  disabled?: boolean;
  /** Tooltip override — read-only agents get the gated reason instead. */
  title?: string;
}

export function EmojiPicker({ onSelect, disabled, title }: EmojiPickerProps) {
  const t = useTranslations('inbox.composer');

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<EmojiCategoryId>(
    EMOJI_CATEGORIES[0].id
  );
  const [recent, setRecent] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  // Recents are re-read on every open rather than on mount, so picks made
  // in another tab show up without a reload.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    setRecent(readRecent());
    setQuery('');
    // Focus lands on search so an agent can type "thumb" and hit the grid.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  const searching = query.trim().length > 0;

  const visible = useMemo(() => {
    if (searching) return searchEmojis(query);
    return (
      EMOJI_CATEGORIES.find((c) => c.id === category) ?? EMOJI_CATEGORIES[0]
    ).emojis;
  }, [searching, query, category]);

  const pick = useCallback(
    (emoji: string) => {
      onSelect(emoji);
      const next = [emoji, ...recent.filter((x) => x !== emoji)].slice(
        0,
        RECENT_MAX
      );
      setRecent(next);
      writeRecent(next);
      // Popover stays open: agents usually add a couple in a row, and the
      // composer keeps focus/caret handling on its side.
    },
    [onSelect, recent]
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        title={title ?? t('emoji')}
        aria-label={t('emoji')}
        className="text-muted-foreground hover:text-foreground inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Smile className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-[19.5rem] gap-2 p-2"
      >
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('emojiSearchPlaceholder')}
          className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 w-full rounded-md border px-2.5 py-1.5 text-xs outline-none"
        />

        {!searching && recent.length > 0 && (
          <div>
            <p className="text-muted-foreground mb-1 text-[10px] tracking-wide uppercase">
              {t('emojiRecent')}
            </p>
            <div className="grid grid-cols-8 gap-0.5">
              {recent.map((emoji) => (
                <EmojiButton
                  key={`recent-${emoji}`}
                  char={emoji}
                  onPick={pick}
                />
              ))}
            </div>
          </div>
        )}

        <div className="grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto">
          {visible.map((entry) => (
            <EmojiButton key={entry.char} char={entry.char} onPick={pick} />
          ))}
          {visible.length === 0 && (
            <p className="text-muted-foreground col-span-8 py-6 text-center text-xs">
              {t('emojiNoResults')}
            </p>
          )}
        </div>

        {!searching && (
          <div className="border-border flex items-center justify-between border-t pt-1.5">
            {EMOJI_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                title={t(`emojiCategory.${c.id}`)}
                aria-label={t(`emojiCategory.${c.id}`)}
                aria-pressed={category === c.id}
                className={cn(
                  'hover:bg-muted rounded-md px-1 py-1 text-base leading-none transition-colors',
                  category === c.id && 'bg-muted'
                )}
              >
                <span aria-hidden>{c.icon}</span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EmojiButton({
  char,
  onPick,
}: {
  char: string;
  onPick: (emoji: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(char)}
      aria-label={char}
      className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none transition-colors"
    >
      <span aria-hidden>{char}</span>
    </button>
  );
}
