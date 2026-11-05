import { describe, expect, it } from 'vitest';
import { mediaSettingsProblem } from './settings';

describe('mediaSettingsProblem', () => {
  it('accepts a 64-character hex key', () => {
    expect(mediaSettingsProblem({ ENCRYPTION_KEY: 'a'.repeat(64) })).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'abc123'],
    ['not hex', 'z'.repeat(64)],
  ])('reports a key that is %s', (_name, value) => {
    expect(mediaSettingsProblem({ ENCRYPTION_KEY: value })).toContain('ENCRYPTION_KEY');
  });

  it('never includes the value in the message', () => {
    expect(mediaSettingsProblem({ ENCRYPTION_KEY: 'SECRETVALUE' })).not.toContain('SECRETVALUE');
  });
});
