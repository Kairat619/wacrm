import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { canSendMessages } from '@/lib/auth/roles';
import { catalogBaseUrl, searchCatalog } from '@/lib/sharapat/catalog';

/**
 * GET /api/products/search?q=... — product lookup for the inbox composer,
 * proxied to the SharapatSKLAD storefront catalog. Agents and up only.
 */
export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }
  if (!canSendMessages(ctx.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!catalogBaseUrl()) {
    return NextResponse.json({ error: 'Product lookup is off' }, { status: 503 });
  }

  const q = new URL(request.url).searchParams.get('q') ?? '';
  try {
    const products = await searchCatalog(q);
    return NextResponse.json({ products });
  } catch (err) {
    console.error('[products/search] catalog lookup failed:', err);
    return NextResponse.json({ error: 'Catalog unavailable' }, { status: 502 });
  }
}
