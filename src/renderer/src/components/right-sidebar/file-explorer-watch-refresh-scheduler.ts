import type { FileExplorerTreeRefreshOutcome } from './file-explorer-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  WATCH_BATCH_MAX_WAIT_MS,
  WATCH_BATCH_TRAILING_MS
} from '../../../../shared/filesystem-watch-batch-window'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'

type SchedulerTimer = ReturnType<typeof setTimeout>

export type FileExplorerWatchRefreshScheduler = {
  requestFullRefresh: () => void
  requestDirRefresh: (dirPath: string) => void
  cancel: () => void
}

export type CreateFileExplorerWatchRefreshSchedulerParams = {
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  refreshDir: (dirPath: string) => Promise<void>
  /** Dirs a full tree refresh already re-reads; the scheduler has no view of `expanded`. */
  isCoveredByFullRefresh: (dirPath: string) => boolean
  dirConcurrency: number
  trailingMs?: number
  maxWaitMs?: number
  schedule?: (callback: () => void, delayMs: number) => SchedulerTimer
  clear?: (timer: SchedulerTimer) => void
}

/**
 * Coalesces watcher-driven File Explorer refreshes into one debounced run.
 *
 * Why: an overflow storm otherwise issues K × (1 + N_expanded) readDirectory
 * round trips on the same SSH mux that carries PTY output. Transport-agnostic on
 * purpose — it sits above both the Electron fs:changed bus and the runtime-RPC
 * file-change subscription.
 */
export function createFileExplorerWatchRefreshScheduler({
  refreshTree,
  refreshDir,
  isCoveredByFullRefresh,
  dirConcurrency,
  trailingMs = WATCH_BATCH_TRAILING_MS,
  maxWaitMs = WATCH_BATCH_MAX_WAIT_MS,
  schedule = setTimeout,
  clear = clearTimeout
}: CreateFileExplorerWatchRefreshSchedulerParams): FileExplorerWatchRefreshScheduler {
  let pendingFull = false
  const pendingDirs = new Map<string, string>()
  let firstRequestAt: number | null = null
  let timer: SchedulerTimer | null = null
  let inFlight: Promise<void> | null = null
  let disposed = false

  function clearTimer(): void {
    if (timer !== null) {
      clear(timer)
      timer = null
    }
  }

  function arm(delayMs: number): void {
    clearTimer()
    timer = schedule(() => {
      timer = null
      // Why: a run started here would race the in-flight one; the settle
      // handler re-arms instead, so nothing pending is dropped.
      if (inFlight === null) {
        run()
      }
    }, delayMs)
  }

  function armForRequest(): void {
    firstRequestAt ??= Date.now()
    arm(Math.max(0, Math.min(trailingMs, firstRequestAt + maxWaitMs - Date.now())))
  }

  function run(): void {
    const full = pendingFull
    const dirs = Array.from(pendingDirs.values())
    pendingFull = false
    pendingDirs.clear()
    firstRequestAt = null

    const started = (async () => {
      // Why: isCoveredByFullRefresh reads a live `expanded` ref, so resolve it
      // against the set refreshTree is about to read — a dir expanded during the
      // tree refresh was never re-read and must keep its pending refresh.
      const covered = full ? new Set(dirs.filter(isCoveredByFullRefresh)) : null
      const outcome = full && !disposed ? await refreshTree() : null
      // Why: refreshTree bails without touching the expanded dirs when its root load is
      // superseded, so trusting `covered` there would drop those refreshes for good — nothing
      // marks an expanded dir stale, so a later re-expansion won't re-read it either.
      // Why: 'root-unreadable' is the opposite case. The transport just failed a read, so
      // re-issuing buys one dead timeout per dir and holds `inFlight` open the whole time,
      // blocking every later refresh. Drop them; a recovered watcher resyncs with an overflow.
      const outstanding =
        outcome === 'root-unreadable'
          ? []
          : covered && outcome === 'refreshed'
            ? dirs.filter((dirPath) => !covered.has(dirPath))
            : dirs
      // Why: forEachWithConcurrency has no cancel hook, and the bound refreshDir
      // is a live ref — a queued path would otherwise be read against the next
      // worktree's binding after a switch.
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
          arm(trailingMs)
        }
      })
  }

  return {
    requestFullRefresh: () => {
      if (disposed) {
        return
      }
      // Why: pendingDirs is deliberately NOT cleared. toggleDir drops a dir from
      // expandedDirs without purging dirCache, so cache keys are a strict
      // superset of what refreshTree re-reads; subsuming them would strand a
      // stale listing for a collapsed-but-cached dir.
      pendingFull = true
      armForRequest()
    },
    requestDirRefresh: (dirPath: string) => {
      if (disposed) {
        return
      }
      pendingDirs.set(normalizeRuntimePathForComparison(dirPath), dirPath)
      armForRequest()
    },
    cancel: () => {
      disposed = true
      clearTimer()
      pendingFull = false
      pendingDirs.clear()
      firstRequestAt = null
    }
  }
}
