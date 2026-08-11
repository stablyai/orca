// Why: the main-process watcher batcher and the renderer's Explorer refresh
// scheduler share one flush window so local and remote latency can't drift.

export const WATCH_BATCH_TRAILING_MS = 150
export const WATCH_BATCH_MAX_WAIT_MS = 500
