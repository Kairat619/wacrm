"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Pencil, Plus, Sparkles, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import type { QuickReply, QuickReplyKind } from "@/types";
import {
  QUICK_REPLY_LANGUAGES,
  normalizeShortcut,
  type QuickReplyLanguage,
} from "@/lib/quick-replies/fields";
import { STARTER_QUICK_REPLIES } from "@/lib/quick-replies/starter-pack";

interface DraftState {
  id?: string;
  title: string;
  kind: QuickReplyKind;
  content_text: string;
  interactive_payload: InteractiveMessagePayload;
  language: QuickReplyLanguage | null;
  shortcut: string;
}

function emptyDraft(): DraftState {
  return {
    title: "",
    kind: "text",
    content_text: "",
    interactive_payload: blankButtonsPayload(),
    language: null,
    shortcut: "",
  };
}

export function QuickRepliesManager() {
  const t = useTranslations("Settings.quickReplies");
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
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
    void load();
  }, [load]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (qr: QuickReply) =>
    setDraft({
      id: qr.id,
      title: qr.title,
      kind: qr.kind,
      content_text: qr.content_text ?? "",
      interactive_payload:
        qr.interactive_payload ?? blankButtonsPayload(),
      language: (qr.language as QuickReplyLanguage | null) ?? null,
      shortcut: qr.shortcut ?? "",
    });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    if (!normalizeShortcut(draft.shortcut).ok) {
      toast.error(t("shortcutInvalid"));
      return;
    }
    const common = {
      title: draft.title,
      language: draft.language,
      shortcut: draft.shortcut,
    };
    const payload =
      draft.kind === "interactive"
        ? { ...common, kind: "interactive", interactive_payload: draft.interactive_payload }
        : { ...common, kind: "text", content_text: draft.content_text };

    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("saveError"));
        return;
      }
      toast.success(draft.id ? t("updated") : t("created"));
      setDraft(null);
      await load();
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [draft, load, t]);

  // One click to add the kk/ru starter set. Skips any whose shortcut the
  // account already uses, so running it twice adds nothing.
  const [addingStarters, setAddingStarters] = useState(false);
  const addStarters = useCallback(async () => {
    setAddingStarters(true);
    const taken = new Set(items.map((i) => i.shortcut).filter(Boolean));
    let added = 0;
    try {
      for (const starter of STARTER_QUICK_REPLIES) {
        if (taken.has(starter.shortcut)) continue;
        const res = await fetch("/api/quick-replies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...starter, kind: "text" }),
        });
        if (res.ok) added++;
      }
      toast.success(t("startersAdded", { count: added }));
      await load();
    } catch {
      toast.error(t("saveError"));
    } finally {
      setAddingStarters(false);
    }
  }, [items, load, t]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm(t("deleteConfirm"))) return;
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(t("deleteError"));
        return;
      }
      await load();
    },
    [load, t],
  );

  return (
    <div>
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={addStarters} disabled={addingStarters || loading}>
              {addingStarters ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-4 w-4" />
              )}
              {t("addStarters")}
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t("new")}
            </Button>
          </div>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((qr) => (
            <li
              key={qr.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              {qr.kind === "interactive" ? (
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                  <span className="truncate">{qr.title}</span>
                  {qr.shortcut ? (
                    <code className="rounded bg-muted px-1 text-xs font-normal text-muted-foreground">
                      /{qr.shortcut}
                    </code>
                  ) : null}
                  {qr.language ? (
                    <span className="rounded border border-border px-1 text-[10px] font-normal uppercase text-muted-foreground">
                      {qr.language}
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {qr.kind === "interactive" && qr.interactive_payload
                    ? interactivePayloadPreviewText(qr.interactive_payload)
                    : qr.content_text}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(qr)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(qr.id)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("edit") : t("new")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">{t("nameLabel")}</label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder={t("namePlaceholder")}
                  className="bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">{t("shortcutLabel")}</label>
                  <Input
                    value={draft.shortcut}
                    onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })}
                    placeholder={t("shortcutPlaceholder")}
                    className="bg-muted text-foreground"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">{t("languageLabel")}</label>
                  <div className="flex gap-2">
                    <KindTab
                      active={draft.language === null}
                      label={t("languageAny")}
                      onClick={() => setDraft({ ...draft, language: null })}
                    />
                    {QUICK_REPLY_LANGUAGES.map((lang) => (
                      <KindTab
                        key={lang}
                        active={draft.language === lang}
                        label={t(`language_${lang}`)}
                        onClick={() => setDraft({ ...draft, language: lang })}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <KindTab
                  active={draft.kind === "text"}
                  label={t("kindText")}
                  onClick={() => setDraft({ ...draft, kind: "text" })}
                />
                <KindTab
                  active={draft.kind === "interactive"}
                  label={t("kindInteractive")}
                  onClick={() => setDraft({ ...draft, kind: "interactive" })}
                />
              </div>
              {draft.kind === "text" ? (
                <Textarea
                  value={draft.content_text}
                  onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                  placeholder={t("textPlaceholder")}
                  className="min-h-28 bg-muted text-foreground"
                />
              ) : null}
              {draft.kind === "text" ? (
                <p className="text-xs text-muted-foreground">{t("placeholdersHint")}</p>
              ) : (
                <InteractiveBuilder
                  value={draft.interactive_payload}
                  onChange={(p) => setDraft({ ...draft, interactive_payload: p })}
                />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KindTab({
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
      className={
        active
          ? "flex-1 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
          : "flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}
