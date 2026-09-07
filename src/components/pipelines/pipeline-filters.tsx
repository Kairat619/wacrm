"use client";

import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import type { Deal } from "@/types";
import { Input } from "@/components/ui/input";

export interface DealFilters {
  search: string;
}

export const EMPTY_DEAL_FILTERS: DealFilters = { search: "" };

/** Digits only — so "701 234" matches a stored "+7 (701) 234-00-00". */
function digits(value: string) {
  return value.replace(/\D/g, "");
}

/**
 * A deal matches when EVERY whitespace-separated term hits at least one of
 * its searchable fields. AND-ing the terms lets a rep narrow a long column
 * by typing "anna proposal" instead of recalling the exact title.
 */
function matchesSearch(deal: Deal, search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return true;

  const haystack = [
    deal.title,
    deal.contact?.name,
    deal.contact?.phone,
    deal.assignee?.full_name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const phoneDigits = digits(deal.contact?.phone ?? "");

  return query.split(/\s+/).every((term) => {
    if (haystack.includes(term)) return true;
    const termDigits = digits(term);
    return termDigits.length > 0 && phoneDigits.includes(termDigits);
  });
}

export function filterDeals(deals: Deal[], filters: DealFilters): Deal[] {
  return deals.filter((deal) => matchesSearch(deal, filters.search));
}

export function hasActiveFilters(filters: DealFilters) {
  return filters.search.trim() !== "";
}

interface PipelineFiltersProps {
  deals: Deal[];
  filters: DealFilters;
  onFiltersChange: (filters: DealFilters) => void;
  matchCount: number;
}

export function PipelineFilters({
  deals,
  filters,
  onFiltersChange,
  matchCount,
}: PipelineFiltersProps) {
  const t = useTranslations("pipelines.filters");
  const active = hasActiveFilters(filters);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(e) => onFiltersChange({ search: e.target.value })}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="border-border bg-card pl-8 pr-8 text-foreground placeholder:text-muted-foreground"
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => onFiltersChange(EMPTY_DEAL_FILTERS)}
            aria-label={t("clearSearch")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {active && (
        <span className="text-xs text-muted-foreground">
          {t("matchCount", { count: matchCount, total: deals.length })}
        </span>
      )}
    </div>
  );
}
