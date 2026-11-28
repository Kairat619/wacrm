"use client";

import { useCallback, useEffect, useState } from "react";

import type { QuickReply } from "@/types";

/**
 * The account's quick replies, fetched on demand. `enabled` lets the
 * composer wait until the agent types "/" before loading anything; the
 * picker passes its `open` flag so every opening shows fresh edits.
 */
export function useQuickReplies(enabled: boolean) {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { items, loading, reload };
}

const LANGUAGE_KEY = "wacrm.quickReplyLanguage";

export function readQuickReplyLanguage(): "kk" | "ru" | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(LANGUAGE_KEY);
  return v === "kk" || v === "ru" ? v : null;
}

export function writeQuickReplyLanguage(value: "kk" | "ru" | null): void {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(LANGUAGE_KEY, value);
  else window.localStorage.removeItem(LANGUAGE_KEY);
}
