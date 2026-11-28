'use client';

import { useMemo, useState } from 'react';
import { Loader2, MessageSquare, Search, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { QuickReply } from '@/types';
import { interactivePayloadPreviewText } from '@/lib/whatsapp/interactive';
import {
  QUICK_REPLY_LANGUAGES,
  filterQuickReplies,
  type QuickReplyLanguage,
} from '@/lib/quick-replies/fields';
import {
  readQuickReplyLanguage,
  useQuickReplies,
  writeQuickReplyLanguage,
} from '@/hooks/use-quick-replies';
import { cn } from '@/lib/utils';

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
}

/**
 * Lists the account's saved quick replies for insertion into the
 * composer. Text snippets fill the textarea; interactive snippets open
 * the builder pre-filled (handled by the caller's onPick). Search
 * covers title, text and shortcut; the language filter is remembered
 * per device.
 */
export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
}: QuickReplyPickerProps) {
  const t = useTranslations('inbox.composer');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('quickReplies')}</DialogTitle>
        </DialogHeader>
        {open ? <PickerBody onPick={onPick} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted per opening, so search and filter start fresh each time. */
function PickerBody({ onPick }: { onPick: (qr: QuickReply) => void }) {
  const t = useTranslations('inbox.composer');
  const { items, loading } = useQuickReplies(true);
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState<QuickReplyLanguage | null>(
    readQuickReplyLanguage
  );

  const visible = useMemo(
    () => filterQuickReplies(items, query, language),
    [items, query, language]
  );

  const chooseLanguage = (value: QuickReplyLanguage | null) => {
    setLanguage(value);
    writeQuickReplyLanguage(value);
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && visible[0]) {
                e.preventDefault();
                onPick(visible[0]);
              }
            }}
            placeholder={t('quickRepliesSearch')}
            className="pl-8"
          />
        </div>
        <div className="flex gap-1">
          <LanguageChip
            active={language === null}
            label={t('quickRepliesAllLanguages')}
            onClick={() => chooseLanguage(null)}
          />
          {QUICK_REPLY_LANGUAGES.map((lang) => (
            <LanguageChip
              key={lang}
              active={language === lang}
              label={lang.toUpperCase()}
              onClick={() => chooseLanguage(lang)}
            />
          ))}
        </div>
      </div>
      <div className="max-h-[55vh] overflow-y-auto">
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-8">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('quickRepliesEmpty')}
          </p>
        ) : visible.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('quickRepliesNoMatch')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {visible.map((qr) => (
              <li key={qr.id}>
                <button
                  type="button"
                  onClick={() => onPick(qr)}
                  className="border-border bg-muted/40 hover:border-primary/50 hover:bg-muted flex w-full items-start gap-2 rounded-md border p-2.5 text-left"
                >
                  {qr.kind === 'interactive' ? (
                    <Zap className="text-primary mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <MessageSquare className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{qr.title}</span>
                      {qr.shortcut ? (
                        <code className="bg-muted text-muted-foreground shrink-0 rounded px-1 text-xs font-normal">
                          /{qr.shortcut}
                        </code>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {qr.kind === 'interactive' && qr.interactive_payload
                        ? interactivePayloadPreviewText(qr.interactive_payload)
                        : qr.content_text}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function LanguageChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-2.5 py-1 text-xs font-medium',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  );
}
