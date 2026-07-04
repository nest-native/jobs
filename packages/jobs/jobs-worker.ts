import type { RunnerConfig } from './interfaces';
import type { JobsClaimer, TickReport } from './jobs-claimer.service';

export interface WorkerLoopOptions {
  /** Delay between ticks when the last tick claimed nothing (default 2000ms). */
  pollIntervalMs?: number;
  /** Runner overrides applied to every tick. */
  runner?: RunnerConfig;
  /** Abort to stop the loop. */
  signal?: AbortSignal;
  /** Called after each successful tick. */
  onTick?: (report: TickReport) => void;
  /** Called when a tick throws — the loop reports and continues. */
  onError?: (error: unknown) => void;
}

/**
 * Runs `claimer.tick()` in a loop until `signal` aborts. When a tick claims a
 * batch it loops immediately to drain the backlog; when it claims nothing it
 * waits `pollIntervalMs`. A throwing tick is reported via `onError` and the loop
 * continues after the same wait.
 */
export async function runWorkerLoop(
  claimer: JobsClaimer,
  options: WorkerLoopOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const { signal } = options;
  while (!signal?.aborted) {
    try {
      const report = await claimer.tick(options.runner);
      options.onTick?.(report);
      if (report.claimed === 0) {
        await sleep(pollIntervalMs, signal);
      }
    } catch (error) {
      options.onError?.(error);
      await sleep(pollIntervalMs, signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
