"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search, SlidersHorizontal, X } from "lucide-react";
import type { Deal } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type DealStatusFilter = "all" | "open" | "won" | "lost";

export interface DealFilters {
  search: string;
  /** "all" | "unassigned" | a profile id */
  assignee: string;
  status: DealStatusFilter;
}

export const EMPTY_DEAL_FILTERS: DealFilters = {
  search: "",
  assignee: "all",
  status: "all",
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

export function filterDeals(deals: Deal[], filters: DealFilters): Deal[] {
  return deals.filter((deal) => {
    if (filters.status !== "all" && (deal.status ?? "open") !== filters.status) {
      return false;
    }
    if (filters.assignee === "unassigned" && deal.assigned_to) return false;
    if (
      filters.assignee !== "all" &&
      filters.assignee !== "unassigned" &&
      deal.assigned_to !== filters.assignee
    ) {
      return false;
    }
    return matchesSearch(deal, filters.search);
  });
}

export function hasActiveFilters(filters: DealFilters) {
  return (
    filters.search.trim() !== "" ||
    filters.assignee !== "all" ||
    filters.status !== "all"
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

  // Only assignees that actually own a deal in this pipeline — a menu of
  // every teammate would be as long as the board we are trying to shorten.
  const assignees = useMemo(() => {
    const map = new Map<string, string>();
    for (const deal of deals) {
      if (deal.assigned_to && deal.assignee?.full_name) {
        map.set(deal.assigned_to, deal.assignee.full_name);
      }
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deals]);

  const active = hasActiveFilters(filters);
  const activeCount =
    (filters.assignee === "all" ? 0 : 1) + (filters.status === "all" ? 0 : 1);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(e) =>
            onFiltersChange({ ...filters, search: e.target.value })
          }
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

      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted data-[popup-open]:bg-muted">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          {t("filters")}
          {activeCount > 0 && (
            <span className="rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
              {activeCount}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56 border-border bg-popover text-popover-foreground"
        >
          <DropdownMenuLabel className="text-muted-foreground">
            {t("status")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filters.status}
            onValueChange={(value) =>
              onFiltersChange({ ...filters, status: value as DealStatusFilter })
            }
          >
            <DropdownMenuRadioItem value="all">
              {t("allStatuses")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="open">
              {t("statusOpen")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="won">
              {t("statusWon")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="lost">
              {t("statusLost")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator className="bg-border" />

          <DropdownMenuLabel className="text-muted-foreground">
            {t("assignee")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filters.assignee}
            onValueChange={(value) =>
              onFiltersChange({ ...filters, assignee: String(value) })
            }
          >
            <DropdownMenuRadioItem value="all">
              {t("allAssignees")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="unassigned">
              {t("unassigned")}
            </DropdownMenuRadioItem>
            {assignees.map((a) => (
              <DropdownMenuRadioItem key={a.id} value={a.id}>
                <span className="truncate">{a.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {active && (
        <>
          <span className="text-xs text-muted-foreground">
            {t("matchCount", { count: matchCount, total: deals.length })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFiltersChange(EMPTY_DEAL_FILTERS)}
            className="text-muted-foreground hover:text-foreground"
          >
            {t("clear")}
          </Button>
        </>
      )}
    </div>
  );
}
