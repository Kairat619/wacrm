import { describe, expect, it } from 'vitest';
import {
  filterQuickReplies,
  normalizeLanguage,
  normalizeShortcut,
  renderPlaceholders,
  shortcutSuggestions,
} from './fields';

describe('normalizeShortcut', () => {
  it('strips the slash and lower-cases', () => {
    expect(normalizeShortcut('/Price')).toEqual({ ok: true, value: 'price' });
    expect(normalizeShortcut('баға')).toEqual({ ok: true, value: 'баға' });
  });
  it('clears on empty or null', () => {
    expect(normalizeShortcut('')).toEqual({ ok: true, value: null });
    expect(normalizeShortcut(null)).toEqual({ ok: true, value: null });
  });
  it('rejects spaces and junk', () => {
    expect(normalizeShortcut('two words')).toEqual({ ok: false });
    expect(normalizeShortcut(5)).toEqual({ ok: false });
    expect(normalizeShortcut('x'.repeat(33))).toEqual({ ok: false });
  });
});

describe('normalizeLanguage', () => {
  it('accepts kk and ru only', () => {
    expect(normalizeLanguage('kk')).toBe('kk');
    expect(normalizeLanguage('ru')).toBe('ru');
    expect(normalizeLanguage('en')).toBeNull();
  });
});

describe('renderPlaceholders', () => {
  it('fills known values', () => {
    expect(
      renderPlaceholders('Сәлеметсіз бе, {{name}}! Мен {{ agent }}.', {
        name: 'Айгүл',
        agent: 'Дана',
      })
    ).toBe('Сәлеметсіз бе, Айгүл! Мен Дана.');
  });
  it('drops a missing value with its leading space', () => {
    expect(renderPlaceholders('Здравствуйте {{name}}!', {})).toBe('Здравствуйте!');
    expect(renderPlaceholders('Сәлеметсіз бе, {{name}}! 😊', { name: ' ' })).toBe(
      'Сәлеметсіз бе! 😊'
    );
  });
});

const items = [
  { title: 'Бағасы', content_text: 'Бағасы: 5 500 тг', shortcut: 'baga', language: 'kk' },
  { title: 'Цена', content_text: 'Цена: 5 500 тг', shortcut: 'cena', language: 'ru' },
  { title: 'Kaspi', content_text: 'Kaspi QR', shortcut: null, language: null },
];

describe('filterQuickReplies', () => {
  it('filters by language, keeping language-less replies', () => {
    expect(filterQuickReplies(items, '', 'kk').map((i) => i.title)).toEqual([
      'Бағасы',
      'Kaspi',
    ]);
  });
  it('searches title, text and shortcut', () => {
    expect(filterQuickReplies(items, '/cena', null).map((i) => i.title)).toEqual(['Цена']);
    expect(filterQuickReplies(items, 'qr', null).map((i) => i.title)).toEqual(['Kaspi']);
  });
});

describe('shortcutSuggestions', () => {
  it('only triggers on a lone slash word', () => {
    expect(shortcutSuggestions(items, '/b').map((i) => i.title)).toEqual(['Бағасы']);
    expect(shortcutSuggestions(items, '/').length).toBe(3);
    expect(shortcutSuggestions(items, 'hi /b')).toEqual([]);
    expect(shortcutSuggestions(items, '/b x')).toEqual([]);
  });
  it('falls back to title prefix', () => {
    expect(shortcutSuggestions(items, '/kas').map((i) => i.title)).toEqual(['Kaspi']);
  });
});
