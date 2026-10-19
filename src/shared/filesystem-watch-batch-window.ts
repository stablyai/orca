// Why: the main-process watcher batcher and the runtime files.watch batcher
// share one flush window so local and remote latency can't drift.

// Why: a trailing debounce never fires while agents write continuously, so a
// busy worktree waited for the max-wait cap on every batch. Instead the first
// change after a quiet period flushes after a short coalescing tick, and a
// sustained stream flushes on a fixed cadence.
// Why 75: the native watcher sends a burst's first event alone and the rest
// ~50ms later; a shorter window splits atomic saves (tmp create + rename).
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
