import { describe, expect, it } from 'vitest';
import { loadDraft, saveDraft } from './draft-store';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe('draft-store', () => {
  it('returns a saved draft for its own conversation only', () => {
    const storage = memoryStorage();
    saveDraft('conv-1', 'hello', storage);

    expect(loadDraft('conv-1', storage)).toBe('hello');
    expect(loadDraft('conv-2', storage)).toBe('');
  });

  it('clears the draft once the text is empty, such as after sending', () => {
    const storage = memoryStorage();
    saveDraft('conv-1', 'hello', storage);
    saveDraft('conv-1', '', storage);

    expect(loadDraft('conv-1', storage)).toBe('');
  });

  it('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };

    expect(() => saveDraft('conv-1', 'hello', broken)).not.toThrow();
    expect(loadDraft('conv-1', broken)).toBe('');
    expect(loadDraft('conv-1', null)).toBe('');
  });
});
