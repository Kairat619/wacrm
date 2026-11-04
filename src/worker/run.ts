import { logEvent } from '@/lib/observability/log';

/**
 * Runs a set of recurring tasks until stopped. Separated from the entry point so
 * the timing and shutdown behaviour can be tested with fake tasks.
 *
 * A task that throws is logged and runs again next time: one bad sweep must not
 * take the worker down. Stopping waits for running tasks, up to a limit, because
 * Railway follows SIGTERM with SIGKILL. Anything cut off is recovered through its
 * lease by the next worker.
 */
export interface RecurringTask {
  name: string;
  intervalMs: number;
  run(): Promise<unknown>;
}

export interface WorkerHandle {
  /** Resolves when running tasks finish or `graceMs` passes, whichever is first. */
  stop(graceMs: number): Promise<void>;
}

export function startWorker(tasks: RecurringTask[]): WorkerHandle {
  let stopping = false;
  const running = new Set<Promise<unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const schedule = (task: RecurringTask, delayMs: number) => {
    if (stopping) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      const execution = task
        .run()
        .catch((error) => {
          logEvent('error', 'worker.task_failed', { task: task.name, error });
        })
        .finally(() => {
          running.delete(execution);
          // Timed from the end of the run, so a slow one can't overlap itself.
          schedule(task, task.intervalMs);
        });
      running.add(execution);
    }, delayMs);
    timers.add(timer);
  };

  for (const task of tasks) schedule(task, 0);

  return {
    async stop(graceMs) {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...running]),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, graceMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    },
  };
}
