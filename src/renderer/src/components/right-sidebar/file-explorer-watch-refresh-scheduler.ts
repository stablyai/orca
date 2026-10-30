import type { FileExplorerTreeRefreshOutcome } from './file-explorer-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'

export type FileExplorerWatchRefreshScheduler = {
  requestFullRefresh: () => void
  requestDirRefresh: (dirPath: string) => void
  /** True when cancellation discarded a received refresh or interrupted one in flight. */
  cancel: () => boolean
}

export type CreateFileExplorerWatchRefreshSchedulerParams = {
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  refreshDir: (dirPath: string) => Promise<void>
  /** Dirs a full tree refresh already re-reads; the scheduler has no view of `expanded`. */
  isCoveredByFullRefresh: (dirPath: string) => boolean
  dirConcurrency: number
}

/** Coalesce pre-batched watch events next tick, serializing refresh waves to avoid repeated SSH round trips; producers own debounce. */
export function createFileExplorerWatchRefreshScheduler({
  refreshTree,
  refreshDir,
  isCoveredByFullRefresh,
  dirConcurrency
}: CreateFileExplorerWatchRefreshSchedulerParams): FileExplorerWatchRefreshScheduler {
  let pendingFull = false
  const pendingDirs = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let disposed = false

  function arm(): void {
    if (timer !== null) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      // Let the in-flight settle handler rearm pending work rather than race another wave.
      if (inFlight === null) {
        run()
      }
    }, 0)
  }

  function run(): void {
    const full = pendingFull
    const dirs = Array.from(pendingDirs.values())
    pendingFull = false
    pendingDirs.clear()

    const started = (async () => {
      // Snapshot coverage before refreshTree reads the live expanded set; later expansions still need pending reads.
      const covered = full ? new Set(dirs.filter(isCoveredByFullRefresh)) : null
      const outcome = full && !disposed ? await refreshTree() : null
      // Retry covered dirs after supersession, but drop them after root transport failure to avoid dead timeouts blocking recovery.
      const outstanding =
        outcome === 'root-unreadable'
          ? []
          : covered && outcome === 'refreshed'
            ? dirs.filter((dirPath) => !covered.has(dirPath))
            : dirs
      // Stop queued reads on dispose before live refreshDir refs bind them to another worktree.
      await forEachWithConcurrency(outstanding, dirConcurrency, (dirPath) =>
        disposed ? Promise.resolve() : refreshDir(dirPath)
      )
    })()
    inFlight = started
    void started
      .catch(() => {
        // Refresh failures are transient; the next watcher event retries.
      })
      .finally(() => {
        if (inFlight === started) {
          inFlight = null
        }
        if (!disposed && (pendingFull || pendingDirs.size > 0)) {
          arm()
        }
      })
  }

  return {
    requestFullRefresh: () => {
      if (disposed) {
        return
      }
      // Preserve pending reads for collapsed cached dirs, which full refresh does not cover.
      pendingFull = true
      arm()
    },
    requestDirRefresh: (dirPath: string) => {
      if (disposed) {
        return
      }
      pendingDirs.set(normalizeRuntimePathForComparison(dirPath), dirPath)
      arm()
    },
    cancel: () => {
      const discardedWork =
        pendingFull || pendingDirs.size > 0 || timer !== null || inFlight !== null
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pendingFull = false
      pendingDirs.clear()
      return discardedWork
    }
  }
}
