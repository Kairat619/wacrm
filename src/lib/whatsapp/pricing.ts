/**
 * Meta's per-message `pricing` block on status webhooks.
 *
 * Since July 2025 (per-message pricing, `pricing_model: "PMP"`) every
 * `sent` / `delivered` status carries:
 *
 *   { billable: boolean, pricing_model: "PMP",
 *     category: "service" | "utility" | "marketing" | "authentication" | ...,
 *     type: "regular" | "free_customer_service" | "free_entry_point" }
 *
 * We store it once per message so cost can be split by agent, origin and
 * conversation. Meta's own totals come from `pricing_analytics` (see
 * `src/lib/billing/sync.ts`); this is the per-message attribution.
 */

export interface MessagePricing {
  billable: boolean | null;
  category: string | null;
  type: string | null;
  model: string | null;
}

export interface MetaStatusPricing {
  billable?: unknown;
  pricing_model?: unknown;
  category?: unknown;
  type?: unknown;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed.slice(0, 64) : null;
}

/** Normalize Meta's pricing block. Returns null when nothing usable is present. */
export function parseStatusPricing(raw: unknown): MessagePricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as MetaStatusPricing;
  const pricing: MessagePricing = {
    billable: typeof p.billable === 'boolean' ? p.billable : null,
    category: cleanString(p.category),
    type: cleanString(p.type),
    model: cleanString(p.pricing_model),
  };
  if (
    pricing.billable === null &&
    !pricing.category &&
    !pricing.type &&
    !pricing.model
  ) {
    return null;
  }
  return pricing;
}

/** Column patch for `messages` / `broadcast_recipients`. */
export function pricingColumns(
  pricing: MessagePricing,
  pricedAt: string
): Record<string, unknown> {
  return {
    pricing_billable: pricing.billable,
    pricing_category: pricing.category,
    pricing_type: pricing.type,
    pricing_model: pricing.model,
    priced_at: pricedAt,
  };
}
