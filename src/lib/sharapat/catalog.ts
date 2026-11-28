/**
 * Product lookup against the SharapatSKLAD storefront catalog
 * (store-bff `GET /api/products?q=`). The storefront is public, so no
 * credentials are involved: this reads the same names, SKUs and prices a
 * customer sees on the site. Used only to draft text for a rep, who
 * always presses Send themselves.
 */

export const DEFAULT_CATALOG_URL = 'https://sharapatsklad-bff.up.railway.app/api';
const TIMEOUT_MS = 8_000;
const CACHE_MS = 60_000;
const CACHE_MAX = 200;

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  price: number | null;
  currency: string;
  inStock: boolean | null;
  quantity: number | null;
  imageUrl: string | null;
}

/** Base URL, or null when the lookup is switched off (`SHARAPAT_CATALOG_URL=off`). */
export function catalogBaseUrl(): string | null {
  const raw = process.env.SHARAPAT_CATALOG_URL?.trim();
  if (raw === 'off') return null;
  return (raw || DEFAULT_CATALOG_URL).replace(/\/+$/, '');
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Map one storefront item; null when it lacks an id or a name. */
export function toCatalogProduct(raw: unknown): CatalogProduct | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const name = str(r.name);
  if (!id || !name) return null;
  return {
    id,
    sku: str(r.sku),
    name,
    price: num(r.price),
    currency: str(r.currency) || 'KZT',
    inStock: typeof r.in_stock === 'boolean' ? r.in_stock : null,
    quantity: num(r.available_quantity),
    imageUrl: str(r.image_url) || null,
  };
}

const cache = new Map<string, { at: number; items: CatalogProduct[] }>();

export function __resetCatalogCacheForTests(): void {
  cache.clear();
}

export async function searchCatalog(
  query: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<CatalogProduct[]> {
  const base = catalogBaseUrl();
  const q = query.trim().slice(0, 80);
  if (!base || q.length < 2) return [];

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.items;

  const url = `${base}/products?q=${encodeURIComponent(q)}&page_size=8`;
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`catalog responded ${res.status}`);
  const body = (await res.json()) as { items?: unknown[] };
  const items = (body.items ?? [])
    .map(toCatalogProduct)
    .filter((p): p is CatalogProduct => p !== null);

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { at: now, items });
  return items;
}

/**
 * One line for the composer: "Name (SKU) — 5 500 ₸". Stock is left out
 * on purpose: the storefront count can lag the warehouse, so the rep
 * confirms availability in their own words.
 */
export function formatProductLine(
  product: Pick<CatalogProduct, 'name' | 'sku' | 'price' | 'currency'>,
  locale = 'ru-RU'
): string {
  const sku = product.sku ? ` (${product.sku})` : '';
  if (product.price == null) return `${product.name}${sku}`;
  const amount = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(product.price);
  const unit = product.currency === 'KZT' ? '₸' : product.currency;
  return `${product.name}${sku} — ${amount} ${unit}`;
}
