import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { watchedDirectoryDeletionCheck } from '../../file-watch/windows-deleted-directory-watch'

export type TranscriptNativeWatcher = {
  /** Best-effort bind; false keeps the caller in reconciliation-only mode. */
  bind: () => boolean
  /** Detach from an identity that may no longer represent the watched path. */
  invalidate: () => void
  needsRebind: () => boolean
  dispose: () => void
}

/** Native watches only accelerate polling reconciliation: remote filesystems may reject them while files remain readable, so retry binding without owning liveness. */
export function createTranscriptNativeWatcher(
  filePath: string,
  onEvent: () => void,
  onError: () => void,
  options: { watchParent?: boolean } = {}
): TranscriptNativeWatcher {
  const watchedName = basename(filePath)
  let disposed = false
  let watcher: FSWatcher | null = null
  let rebindNeeded = true

  function invalidateCandidate(candidate: FSWatcher): void {
    if (watcher !== candidate) {
      return
    }
    watcher = null
    rebindNeeded = true
    candidate.close()
  }

  return {
    bind(): boolean {
      if (disposed || watcher) {
        return watcher !== null
      }
      // Parent watches survive replacement; append-only readers can watch one file to avoid sibling events.
      const watchParent = options.watchParent !== false
      const watchedPath = watchParent ? dirname(filePath) : filePath
      // libuv's deleted-directory loop only affects directory watches.
      const isParentDeleted = watchParent ? watchedDirectoryDeletionCheck(watchedPath) : null
      let nextWatcher: FSWatcher
      const onWatcherError = (): void => {
        if (disposed || watcher !== nextWatcher) {
          return
        }
        invalidateCandidate(nextWatcher)
        onError()
      }
      try {
        nextWatcher = watch(watchedPath, (event, changedName) => {
          if (isParentDeleted?.(event, changedName)) {
            onWatcherError()
            return
          }
          if (changedName !== null && changedName.toString() !== watchedName) {
            return
          }
          // Why: a parent replacement may emit rename without a watcher error.
          if (event === 'rename') {
            invalidateCandidate(nextWatcher)
          }
          onEvent()
        })
      } catch {
        rebindNeeded = true
        return false
      }
      // Why: an active tail should not keep a headless runtime alive during shutdown.
      nextWatcher.unref?.()
      nextWatcher.on('error', onWatcherError)
      watcher = nextWatcher
      rebindNeeded = false
      return true
    },
    invalidate(): void {
      if (watcher) {
        invalidateCandidate(watcher)
      } else {
        rebindNeeded = true
      }
    },
    needsRebind: () => rebindNeeded,
    dispose(): void {
      disposed = true
      watcher?.close()
      watcher = null
      rebindNeeded = false
    }
  }
}
