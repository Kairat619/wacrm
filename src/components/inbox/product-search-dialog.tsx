'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Package, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatProductLine, type CatalogProduct } from '@/lib/sharapat/catalog';

interface ProductSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the formatted "Name (SKU) — price" line for the draft. */
  onPick: (line: string) => void;
}

const DEBOUNCE_MS = 300;

/**
 * Look a product up in the SharapatSKLAD catalog by name or SKU and drop
 * its name and price into the draft. Nothing is sent from here.
 */
export function ProductSearchDialog({
  open,
  onOpenChange,
  onPick,
}: ProductSearchDialogProps) {
  const t = useTranslations('inbox.composer');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('productSearch')}</DialogTitle>
        </DialogHeader>
        {open ? (
          <SearchBody
            onPick={(line) => {
              onPick(line);
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted per opening, so each search starts empty. */
function SearchBody({ onPick }: { onPick: (line: string) => void }) {
  const t = useTranslations('inbox.composer');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const request = ++requestRef.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/products/search?q=${encodeURIComponent(q)}`,
          { cache: 'no-store' }
        );
        const data = await res.json().catch(() => ({}));
        if (request !== requestRef.current) return;
        if (!res.ok) {
          setError(
            res.status === 503
              ? t('productSearchOff')
              : t('productSearchFailed')
          );
          setResults([]);
          return;
        }
        setError(null);
        setResults((data.products as CatalogProduct[]) ?? []);
      } catch {
        if (request === requestRef.current) setError(t('productSearchFailed'));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, t]);

  const short = query.trim().length < 2;
  const shown = short ? [] : results;
  const pick = (p: CatalogProduct) => onPick(formatProductLine(p));

  return (
    <>
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) {
              e.preventDefault();
              pick(shown[0]);
            }
          }}
          placeholder={t('productSearchPlaceholder')}
          className="pl-8"
        />
      </div>
      <div className="max-h-[55vh] min-h-24 overflow-y-auto">
        {loading && !short ? (
          <div className="flex justify-center py-8">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : error && !short ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {error}
          </p>
        ) : short ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('productSearchHint')}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('productSearchEmpty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {shown.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => pick(p)}
                  className="border-border bg-muted/40 hover:border-primary/50 hover:bg-muted flex w-full items-center gap-3 rounded-md border p-2 text-left"
                >
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- remote catalog thumbnail, no optimisation needed
                    <img
                      src={p.imageUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded">
                      <Package className="text-muted-foreground h-4 w-4" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {p.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {p.sku}
                      {p.inStock === false
                        ? ` · ${t('productNoStoreStock')}`
                        : ''}
                    </span>
                  </span>
                  {p.price != null ? (
                    <span className="text-foreground shrink-0 text-sm tabular-nums">
                      {new Intl.NumberFormat('ru-RU', {
                        maximumFractionDigits: 0,
                      }).format(p.price)}{' '}
                      ₸
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-muted-foreground text-[11px]">
        {t('productSearchFootnote')}
      </p>
    </>
  );
}
