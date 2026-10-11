export type DownloadProgress = {
  transferredBytes: number
  /** Null when the size is not known, e.g. a stat an older server could not answer. */
  totalBytes: number | null
}

export const DOWNLOAD_PROGRESS_INTERVAL_MS = 100

export type DownloadProgressTracker = {
  addBytes: (bytes: number) => void
  flush: () => void
}

export function createDownloadProgressTracker(args: {
  totalBytes: number | null
  emit: (progress: DownloadProgress) => void
  now?: () => number
}): DownloadProgressTracker {
  const now = args.now ?? Date.now
  const { totalBytes } = args
  let transferredBytes = 0
  let lastEmittedAt = -Infinity
  let dirty = true

  const flush = (): void => {
    if (!dirty) {
      return
    }
    dirty = false
    lastEmittedAt = now()
    args.emit({ transferredBytes, totalBytes })
  }

  return {
    addBytes: (bytes) => {
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return
      }
      transferredBytes += bytes
      dirty = true
      // Why: fast links deliver many chunks per second; re-rendering the toast for each costs
      // more than the transfer itself.
      if (now() - lastEmittedAt >= DOWNLOAD_PROGRESS_INTERVAL_MS) {
        flush()
      }
    },
    flush
  }
}
