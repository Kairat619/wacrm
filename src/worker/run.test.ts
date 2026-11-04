import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from './run';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startWorker', () => {
  it('runs each task straight away, then on its interval', async () => {
    const run = vi.fn(async () => {});
    const worker = startWorker([{ name: 't', intervalMs: 1000, run }]);

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    await worker.stop(0);
  });

  it('keeps running after a task throws', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const worker = startWorker([{ name: 't', intervalMs: 1000, run }]);

    await vi.advanceTimersByTimeAsync(2000);

    expect(run).toHaveBeenCalledTimes(3);
    await worker.stop(0);
  });

  it('never overlaps a slow task with itself', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const worker = startWorker([{ name: 't', intervalMs: 100, run }]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);

    finish();
    await worker.stop(0);
  });

  it('starts nothing new after stopping, and waits for what is running', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const worker = startWorker([{ name: 't', intervalMs: 100, run }]);
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = worker.stop(30_000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting at the limit, leaving the lease to recover the work', async () => {
    const run = vi.fn(() => new Promise<void>(() => {}));
    const worker = startWorker([{ name: 't', intervalMs: 100, run }]);
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    void worker.stop(5000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(stopped).toBe(true);
  });
});
