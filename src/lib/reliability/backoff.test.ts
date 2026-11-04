import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from './backoff';

const OPTIONS = { baseMs: 1000, maxMs: 60_000 };

describe('backoffDelayMs', () => {
  it('doubles the ceiling with each attempt', () => {
    const top = { ...OPTIONS, random: () => 0.999999 };
    expect(backoffDelayMs(1, top)).toBeLessThan(1000);
    expect(backoffDelayMs(2, top)).toBeGreaterThan(1000);
    expect(backoffDelayMs(2, top)).toBeLessThan(2000);
    expect(backoffDelayMs(3, top)).toBeGreaterThan(2000);
  });

  it('never exceeds the maximum, even for a huge attempt count', () => {
    expect(backoffDelayMs(5000, { ...OPTIONS, random: () => 0.999999 })).toBeLessThan(60_000);
  });

  it('applies jitter across the whole range', () => {
    expect(backoffDelayMs(3, { ...OPTIONS, random: () => 0 })).toBe(0);
    expect(backoffDelayMs(3, { ...OPTIONS, random: () => 0.5 })).toBe(2000);
  });

  it('treats Retry-After as a minimum wait', () => {
    expect(
      backoffDelayMs(1, { ...OPTIONS, retryAfterSeconds: 120, random: () => 0 })
    ).toBe(120_000);
  });

  it('honours Retry-After even above the usual maximum', () => {
    expect(
      backoffDelayMs(1, { ...OPTIONS, retryAfterSeconds: 3600, random: () => 0 })
    ).toBe(3_600_000);
  });
});
