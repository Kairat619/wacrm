import { describe, expect, it } from 'vitest';
import { formatLogLine } from './log';

const parse = (fields: Record<string, unknown>) =>
  JSON.parse(formatLogLine('info', 'test.event', fields));

describe('formatLogLine', () => {
  it('emits one JSON line with level, event and fields', () => {
    const line = formatLogLine(
      'warn',
      'media.retry',
      { attempt: 2 },
      new Date('2026-01-01T00:00:00Z')
    );
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'warn',
      event: 'media.retry',
      attempt: 2,
    });
  });

  it.each([
    'access_token',
    'refreshToken',
    'password',
    'Authorization',
    'phone',
    'api_key',
    'x-hub-signature-256',
  ])('redacts %s', (key) => {
    expect(parse({ [key]: 'SENSITIVE' })[key]).toBe('[redacted]');
  });

  it('redacts sensitive keys inside nested objects', () => {
    const line = formatLogLine('info', 'e', {
      outer: { items: [{ access_token: 'SENSITIVE' }] },
    });
    expect(line).not.toContain('SENSITIVE');
  });

  it('removes the path and query from URLs, which can be signed', () => {
    const line = formatLogLine('error', 'e', {
      error: 'failed fetching https://lookaside.fbsbx.com/a/b?hash=SIGNED&ext=1',
    });
    expect(line).not.toContain('SIGNED');
    expect(line).toContain('https://lookaside.fbsbx.com/[redacted]');
  });

  it('scrubs URLs out of Error messages', () => {
    const line = formatLogLine('error', 'e', {
      error: new Error('bad https://r2.test/key?X-Amz-Signature=SIGNED'),
    });
    expect(line).not.toContain('SIGNED');
  });

  it('keeps ordinary values', () => {
    expect(parse({ code: 131049, retryable: false })).toMatchObject({
      code: 131049,
      retryable: false,
    });
  });
});
