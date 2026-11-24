import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import {
  countCustomerMessagesAfter,
  lastCustomerMessageId,
  shouldFollowLatest,
} from "./thread-scroll";

function msg(id: string, sender_type: Message["sender_type"]): Message {
  return {
    id,
    conversation_id: "conv-1",
    sender_type,
    content_type: "text",
    content_text: id,
    status: "sent",
    created_at: "2026-05-18T10:00:00.000Z",
  };
}

// 1000px of content in a 400px viewport: the bottom is scrollTop 600.
const at = (
  scrollTop: number,
  previousScrollTop: number,
  scrollHeight = 1000,
) => ({ scrollTop, previousScrollTop, scrollHeight, clientHeight: 400 });

describe("shouldFollowLatest", () => {
  it("stops following once the agent scrolls up", () => {
    expect(shouldFollowLatest(true, at(300, 600))).toBe(false);
  });

  it("stays off while the agent scrolls down but not to the bottom", () => {
    expect(shouldFollowLatest(false, at(400, 300))).toBe(false);
  });

  it("resumes at the bottom", () => {
    expect(shouldFollowLatest(false, at(600, 300))).toBe(true);
    expect(shouldFollowLatest(false, at(560, 300))).toBe(true);
  });

  it("tolerates a small upward nudge", () => {
    expect(shouldFollowLatest(true, at(580, 600))).toBe(true);
  });

  it("keeps following when content grows under a thread at the bottom", () => {
    expect(shouldFollowLatest(true, at(600, 600, 1400))).toBe(true);
    expect(shouldFollowLatest(true, at(600, 0, 1400))).toBe(true);
  });
});

describe("countCustomerMessagesAfter", () => {
  const thread = [
    msg("c1", "customer"),
    msg("a1", "agent"),
    msg("c2", "customer"),
    msg("b1", "bot"),
    msg("c3", "customer"),
  ];

  it("counts only customer messages that arrived since", () => {
    expect(countCustomerMessagesAfter(thread, "c1")).toBe(2);
    expect(countCustomerMessagesAfter(thread, "c3")).toBe(0);
  });

  it("is not affected by older messages loaded above", () => {
    const withOlder = [msg("c0", "customer"), ...thread];
    expect(countCustomerMessagesAfter(withOlder, "c2")).toBe(1);
  });

  it("handles a thread with no customer messages, or a lost marker", () => {
    expect(countCustomerMessagesAfter(thread, null)).toBe(3);
    expect(countCustomerMessagesAfter(thread, "gone")).toBe(0);
  });
});

describe("lastCustomerMessageId", () => {
  it("finds the newest customer message", () => {
    expect(
      lastCustomerMessageId([msg("c1", "customer"), msg("a1", "agent")]),
    ).toBe("c1");
    expect(lastCustomerMessageId([msg("a1", "agent")])).toBeNull();
  });
});
