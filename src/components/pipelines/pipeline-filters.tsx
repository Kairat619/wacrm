"use client";

import { useTranslations } from "next-intl";
import { CalendarDays, Search, X } from "lucide-react";
import { format } from "date-fns";
import type { Deal } from "@/types";
import { Input } from "@/components/ui/input";

export interface DealFilters {
  search: string;
  /** Inclusive lower bound on the deal's creation day, "yyyy-MM-dd" or "". */
  createdFrom: string;
  /** Inclusive upper bound on the deal's creation day, "yyyy-MM-dd" or "". */
  createdTo: string;
}

export const EMPTY_DEAL_FILTERS: DealFilters = {
  search: "",
  createdFrom: "",
  createdTo: "",
};

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

/**
 * Compares the deal's creation day in the viewer's local time zone, so
 * "1–15 Nov" means the calendar days the rep sees, not UTC days. Both
 * bounds are inclusive; an empty bound is open-ended.
 */
function matchesCreatedRange(deal: Deal, from: string, to: string) {
  if (!from && !to) return true;
  if (!deal.created_at) return false;
  const day = format(new Date(deal.created_at), "yyyy-MM-dd");
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function filterDeals(deals: Deal[], filters: DealFilters): Deal[] {
  return deals.filter(
    (deal) =>
      matchesSearch(deal, filters.search) &&
      matchesCreatedRange(deal, filters.createdFrom, filters.createdTo),
  );
}

export function hasActiveFilters(filters: DealFilters) {
  return (
    filters.search.trim() !== "" ||
    filters.createdFrom !== "" ||
    filters.createdTo !== ""
  );
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
  const hasDateRange = filters.createdFrom !== "" || filters.createdTo !== "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="border-border bg-card pl-8 pr-8 text-foreground placeholder:text-muted-foreground"
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => onFiltersChange({ ...filters, search: "" })}
            aria-label={t("clearSearch")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarDays className="size-4" />
        <span>{t("createdLabel")}</span>
        <Input
          type="date"
          value={filters.createdFrom}
          max={filters.createdTo || undefined}
          onChange={(e) => onFiltersChange({ ...filters, createdFrom: e.target.value })}
          aria-label={t("createdFrom")}
          className="h-8 w-auto border-border bg-card text-xs text-foreground"
        />
        <span>–</span>
        <Input
          type="date"
          value={filters.createdTo}
          min={filters.createdFrom || undefined}
          onChange={(e) => onFiltersChange({ ...filters, createdTo: e.target.value })}
          aria-label={t("createdTo")}
          className="h-8 w-auto border-border bg-card text-xs text-foreground"
        />
        {hasDateRange && (
          <button
            type="button"
            onClick={() => onFiltersChange({ ...filters, createdFrom: "", createdTo: "" })}
            aria-label={t("clearDates")}
            title={t("clearDates")}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
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
