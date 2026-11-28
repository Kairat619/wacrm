import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCatalogCacheForTests,
  formatProductLine,
  searchCatalog,
  toCatalogProduct,
} from './catalog';

const item = {
  id: 'p1',
  sku: 'S-0122 KOK',
  name: 'Мадина',
  price: 58000,
  currency: 'KZT',
  in_stock: false,
  available_quantity: 0,
  image_url: 'https://img/x.webp',
};

afterEach(() => {
  __resetCatalogCacheForTests();
  delete process.env.SHARAPAT_CATALOG_URL;
});

describe('toCatalogProduct', () => {
  it('maps the storefront shape', () => {
    expect(toCatalogProduct(item)).toEqual({
      id: 'p1',
      sku: 'S-0122 KOK',
      name: 'Мадина',
      price: 58000,
      currency: 'KZT',
      inStock: false,
      quantity: 0,
      imageUrl: 'https://img/x.webp',
    });
  });

  it('drops items without id or name', () => {
    expect(toCatalogProduct({ id: 'x' })).toBeNull();
    expect(toCatalogProduct(null)).toBeNull();
  });
});

describe('formatProductLine', () => {
  it('formats tenge with grouped digits', () => {
    expect(formatProductLine(toCatalogProduct(item)!).replace(/\s/g, ' ')).toBe(
      'Мадина (S-0122 KOK) — 58 000 ₸'
    );
  });

  it('omits a missing price', () => {
    expect(
      formatProductLine({ name: 'X', sku: '', price: null, currency: 'KZT' })
    ).toBe('X');
  });
});

describe('searchCatalog', () => {
  it('queries the storefront and caches the answer', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [item, { bad: true }] }), {
          status: 200,
        })
    );
    const f = fetchImpl as unknown as typeof fetch;
    const first = await searchCatalog('S-0122', f, 1000);
    const second = await searchCatalog('s-0122', f, 2000);
    expect(first).toHaveLength(1);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
      'https://sharapatsklad-bff.up.railway.app/api/products?q=S-0122&page_size=8'
    );
  });

  it('does nothing for short queries or when switched off', async () => {
    const fetchImpl = vi.fn();
    const f = fetchImpl as unknown as typeof fetch;
    expect(await searchCatalog('a', f)).toEqual([]);
    process.env.SHARAPAT_CATALOG_URL = 'off';
    expect(await searchCatalog('abc', f)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a failed response', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 502 }));
    await expect(
      searchCatalog('abc', fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('502');
  });
});
