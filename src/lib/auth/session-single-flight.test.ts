import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessionChecksForTests,
  shareSessionCheck,
  type SessionCheck,
} from './session-single-flight';

type Check = SessionCheck<{ id: string }, Error>;

const rotated: Check = {
  user: { id: 'u1' },
  error: null,
  cookies: [{ name: 'sb-auth-token', value: 'new' }],
};
const unchanged: Check = { user: { id: 'u1' }, error: null, cookies: [] };

beforeEach(() => {
  __resetSessionChecksForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shareSessionCheck: concurrent session refresh', () => {
  it('runs one refresh for parallel requests with the same cookies', async () => {
    const check = vi.fn(async () => rotated);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => shareSessionCheck('token-a', check))
    );

    expect(check).toHaveBeenCalledTimes(1);
    // Every response gets the new cookies, or its browser keeps the dead token.
    for (const result of results) {
      expect(result.cookies).toEqual(rotated.cookies);
    }
  });

  it('keeps different sessions apart', async () => {
    const check = vi.fn(async () => unchanged);

    await Promise.all([
      shareSessionCheck('user-a', check),
      shareSessionCheck('user-b', check),
    ]);

    expect(check).toHaveBeenCalledTimes(2);
  });

  it('answers a late request holding the old cookie without refreshing again', async () => {
    const check = vi.fn(async () => rotated);

    await shareSessionCheck('token-a', check);
    await vi.advanceTimersByTimeAsync(5_000);
    const late = await shareSessionCheck('token-a', check);

    expect(check).toHaveBeenCalledTimes(1);
    expect(late.cookies).toEqual(rotated.cookies);
  });

  it('forgets a rotated result after the time limit', async () => {
    const check = vi.fn(async () => rotated);

    await shareSessionCheck('token-a', check);
    await vi.advanceTimersByTimeAsync(10_001);
    await shareSessionCheck('token-a', check);

    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does not remember a check that changed nothing', async () => {
    const check = vi.fn(async () => unchanged);

    await shareSessionCheck('token-a', check);
    await vi.advanceTimersByTimeAsync(0);
    await shareSessionCheck('token-a', check);

    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failed refresh, so a retry can try again', async () => {
    const failed: Check = { user: null, error: new Error('refresh_token_not_found'), cookies: [{ name: 'sb', value: '' }] };
    const check = vi.fn(async () => failed);

    await shareSessionCheck('token-a', check);
    await vi.advanceTimersByTimeAsync(0);
    await shareSessionCheck('token-a', check);

    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does not remember a check that threw', async () => {
    const check = vi
      .fn<() => Promise<Check>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(unchanged);

    await expect(shareSessionCheck('token-a', check)).rejects.toThrow('boom');
    await expect(shareSessionCheck('token-a', check)).resolves.toEqual(unchanged);
  });

  it('never shares when there is no session cookie', async () => {
    const check = vi.fn(async () => ({ user: null, error: null, cookies: [] }));

    await Promise.all([shareSessionCheck('', check), shareSessionCheck('', check)]);

    expect(check).toHaveBeenCalledTimes(2);
  });
});
