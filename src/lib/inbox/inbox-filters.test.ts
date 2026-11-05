import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types";
import {
  applyInboxFilter,
  isAwaitingReply,
  isWindowClosing,
  parseInboxFilter,
  type InboxFilter,
} from "./inbox-filters";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    user_id: "u",
    contact_id: `c-${id}`,
    status: "open",
    unread_count: 0,
    created_at: ago(2000),
    updated_at: ago(1),
    ...patch,
  };
}

describe("parseInboxFilter", () => {
  it("accepts every known filter and falls back to all", () => {
    expect(parseInboxFilter("waiting")).toBe("waiting");
    expect(parseInboxFilter("expiring")).toBe("expiring");
    expect(parseInboxFilter("bogus")).toBe("all");
    expect(parseInboxFilter(null)).toBe("all");
  });
});

describe("isAwaitingReply", () => {
  it("is true when the customer spoke last", () => {
    expect(isAwaitingReply(conv("a", { last_inbound_at: ago(10) }))).toBe(true);
    expect(isAwaitingReply(conv("b", { last_inbound_at: ago(10), last_reply_at: ago(20) }))).toBe(true);
  });

  it("is false once someone replied, or the chat is closed", () => {
    expect(isAwaitingReply(conv("a", { last_inbound_at: ago(20), last_reply_at: ago(10) }))).toBe(false);
    expect(isAwaitingReply(conv("b", { status: "closed", last_inbound_at: ago(10) }))).toBe(false);
    expect(isAwaitingReply(conv("c"))).toBe(false);
  });

  it("does not use unread_count, which resets when anyone opens the chat", () => {
    expect(isAwaitingReply(conv("a", { unread_count: 3 }))).toBe(false);
    expect(isAwaitingReply(conv("b", { unread_count: 0, last_inbound_at: ago(5) }))).toBe(true);
  });
});

describe("isWindowClosing", () => {
  it("flags waiting chats whose 24 h window ends within 2 h", () => {
    expect(isWindowClosing(conv("a", { last_inbound_at: ago(23 * 60) }), NOW)).toBe(true);
    expect(isWindowClosing(conv("b", { last_inbound_at: ago(20 * 60) }), NOW)).toBe(false);
    expect(isWindowClosing(conv("c", { last_inbound_at: ago(25 * 60) }), NOW)).toBe(false);
  });

  it("ignores chats that already got a reply", () => {
    expect(
      isWindowClosing(conv("a", { last_inbound_at: ago(23 * 60), last_reply_at: ago(60) }), NOW),
    ).toBe(false);
  });
});

describe("applyInboxFilter", () => {
  const list = [
    conv("recent", { last_inbound_at: ago(5) }),
    conv("old", { last_inbound_at: ago(90), assigned_agent_id: "agent-1" }),
    conv("answered", { last_inbound_at: ago(60), last_reply_at: ago(30) }),
    conv("pending", { status: "pending", assigned_agent_id: "agent-1" }),
    conv("unread", { unread_count: 2, assigned_agent_id: "agent-1" }),
  ];

  it("lists waiting chats oldest first", () => {
    expect(applyInboxFilter(list, "waiting", NOW).map((c) => c.id)).toEqual(["old", "recent"]);
  });

  it("lists open chats nobody is assigned to", () => {
    expect(applyInboxFilter(list, "unassigned", NOW).map((c) => c.id)).toEqual(["recent", "answered"]);
  });

  it("keeps the existing unread and status filters", () => {
    expect(applyInboxFilter(list, "unread", NOW).map((c) => c.id)).toEqual(["unread"]);
    expect(applyInboxFilter(list, "pending", NOW).map((c) => c.id)).toEqual(["pending"]);
    expect(applyInboxFilter(list, "all", NOW).map((c) => c.id).sort()).toEqual(
      list.map((c) => c.id).sort(),
    );
  });

  it("does not reorder the caller's array", () => {
    const before = list.map((c) => c.id);
    applyInboxFilter(list, "waiting", NOW);
    applyInboxFilter(list, "all", NOW);
    expect(list.map((c) => c.id)).toEqual(before);
  });
});

describe("inbox ordering", () => {
  const ids = (list: Conversation[], filter: InboxFilter = "all") =>
    applyInboxFilter(list, filter, NOW).map((c) => c.id);

  it("lists read chats newest first", () => {
    const list = [
      conv("old", { last_message_at: ago(90) }),
      conv("new", { last_message_at: ago(5) }),
      conv("mid", { last_message_at: ago(30) }),
    ];
    expect(ids(list)).toEqual(["new", "mid", "old"]);
  });

  it("moves a chat up when a new message updates its time", () => {
    const list = [
      conv("a", { last_message_at: ago(5) }),
      conv("b", { last_message_at: ago(10) }),
    ];
    const updated = list.map((c) =>
      c.id === "b" ? { ...c, last_message_at: ago(1) } : c,
    );
    expect(ids(list)).toEqual(["a", "b"]);
    expect(ids(updated)).toEqual(["b", "a"]);
  });

  it("keeps unread chats above newer read ones, newest first", () => {
    const list = [
      conv("read-newest", { last_message_at: ago(1) }),
      conv("unread-old", { last_message_at: ago(120), unread_count: 1 }),
      conv("unread-new", { last_message_at: ago(30), unread_count: 4 }),
    ];
    expect(ids(list)).toEqual(["unread-new", "unread-old", "read-newest"]);
  });

  it("drops a chat back into normal order once it has been read", () => {
    const list = [
      conv("read-newer", { last_message_at: ago(5) }),
      conv("opened", { last_message_at: ago(60), unread_count: 0 }),
    ];
    expect(ids(list)).toEqual(["read-newer", "opened"]);
  });

  it("compares instants, not timestamp strings", () => {
    const list = [
      conv("earlier", { last_message_at: "2026-10-16T12:00:00.000+05:00" }),
      conv("later", { last_message_at: "2026-10-16T08:00:00.000Z" }),
    ];
    expect(ids(list)).toEqual(["later", "earlier"]);
  });

  it("puts conversations with no messages last", () => {
    const list = [conv("empty"), conv("active", { last_message_at: ago(500) })];
    expect(ids(list)).toEqual(["active", "empty"]);
  });

  it("applies the same order to the status filters", () => {
    const list = [
      conv("read", { last_message_at: ago(1) }),
      conv("unread", { last_message_at: ago(60), unread_count: 1 }),
    ];
    expect(ids(list, "open")).toEqual(["unread", "read"]);
    expect(ids(list, "unassigned")).toEqual(["unread", "read"]);
  });

  it("leaves waiting chats oldest first even when one is unread", () => {
    const list = [
      conv("new-unread", { last_inbound_at: ago(5), unread_count: 1 }),
      conv("old-read", { last_inbound_at: ago(90) }),
    ];
    expect(ids(list, "waiting")).toEqual(["old-read", "new-unread"]);
  });
});
