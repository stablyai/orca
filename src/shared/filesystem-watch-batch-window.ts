// Share local/runtime flush timing to prevent latency drift.

// Trailing debounce stalls under continuous agent writes; use a leading coalescing tick then fixed cadence.
// 75 ms joins the native watcher’s first event and ~50 ms tail so atomic saves remain one batch.
export const WATCH_BATCH_LEADING_MS = 75
export const WATCH_BATCH_INTERVAL_MS = 100

/** Delay before flushing a batch armed at `now`; `lastFlushAt` is 0 before the first flush. */
export function watchBatchFlushDelayMs(
  now: number,
  lastFlushAt: number,
  leadingMs: number = WATCH_BATCH_LEADING_MS,
  intervalMs: number = WATCH_BATCH_INTERVAL_MS
): number {
  // Why cap at intervalMs: a backwards wall-clock jump must not stall delivery.
  return Math.min(intervalMs, Math.max(leadingMs, lastFlushAt + intervalMs - now))
}
