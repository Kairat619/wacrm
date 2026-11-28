import { describe, expect, it } from 'vitest';
import {
  currentBurstLength,
  findDuplicateSend,
  type NudgeMessage,
} from './send-nudges';

const NOW = Date.parse('2026-11-28T10:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function out(text: string, secondsAgo: number, status = 'sent'): NudgeMessage {
  return { sender_type: 'agent', content_text: text, created_at: ago(secondsAgo), status };
}
function cust(text: string, secondsAgo: number): NudgeMessage {
  return { sender_type: 'customer', content_text: text, created_at: ago(secondsAgo) };
}

describe('findDuplicateSend', () => {
  it('matches the same text ignoring case and spacing', () => {
    const msgs = [out('Бағасы 5 500 тг.', 3600), cust('ok', 60)];
    expect(findDuplicateSend('  бағасы   5 500 ТГ. ', msgs, NOW)?.created_at).toBe(ago(3600));
  });

  it('ignores short texts, old messages and failed sends', () => {
    expect(findDuplicateSend('ok', [out('ok', 10)], NOW)).toBeNull();
    expect(findDuplicateSend('Цена 5500', [out('Цена 5500', 25 * 3600)], NOW)).toBeNull();
    expect(findDuplicateSend('Цена 5500', [out('Цена 5500', 10, 'failed')], NOW)).toBeNull();
  });

  it('never matches the customer’s own words', () => {
    expect(findDuplicateSend('сколько стоит?', [cust('сколько стоит?', 10)], NOW)).toBeNull();
  });
});

describe('currentBurstLength', () => {
  it('counts a chain of quick outbound messages', () => {
    const msgs = [cust('hi', 300), out('a', 50), out('b', 30), out('c', 10)];
    expect(currentBurstLength(msgs, NOW)).toBe(3);
  });

  it('is zero once the customer replied or the rep paused', () => {
    expect(currentBurstLength([out('a', 20), cust('ok', 5)], NOW)).toBe(0);
    expect(currentBurstLength([out('a', 120)], NOW)).toBe(0);
  });

  it('stops at a gap in the chain', () => {
    const msgs = [out('a', 200), out('b', 20), out('c', 5)];
    expect(currentBurstLength(msgs, NOW)).toBe(2);
  });
});
