import { useSyncExternalStore } from 'react'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import type { FsWatchPausedPayload } from '../../../../../../shared/file-watch/filesystem-change-event'

// Local watch roots whose auto-reload main reports paused, plus roots whose watch request failed here.
const pausedByMain = new Set<string>()
const failedRequests = new Set<string>()
// Roots this renderer holds a watch on; a push that lands after release must not resurrect an entry.
const heldRoots = new Set<string>()
const subscribers = new Set<() => void>()

function rootKey(rootPath: string): string {
  return normalizeRuntimePathForComparison(rootPath)
}

function update(set: Set<string>, rootPath: string, on: boolean): void {
  const key = rootKey(rootPath)
  if (set.has(key) === on) {
    return
  }
  if (on) {
    set.add(key)
  } else {
    set.delete(key)
  }
  for (const notify of subscribers) {
    notify()
  }
}

export function applyLocalWatchPausedPayload(payload: FsWatchPausedPayload): void {
  if (payload.paused && !heldRoots.has(rootKey(payload.worktreePath))) {
    return
  }
  update(pausedByMain, payload.worktreePath, payload.paused)
}

export function noteLocalWatchRootHeld(rootPath: string): void {
  update(heldRoots, rootPath, true)
}

/** The renderer's own `watchWorktree` for this root rejected (true) or a later request succeeded (false). */
export function setLocalWatchRequestFailed(rootPath: string, failed: boolean): void {
  // A rejection that settles after release must not resurrect the root.
  if (failed && !heldRoots.has(rootKey(rootPath))) {
    return
  }
  update(failedRequests, rootPath, failed)
}

/** The renderer stopped holding this root, so main will no longer report on it. */
export function forgetLocalWatchRoot(rootPath: string): void {
  update(heldRoots, rootPath, false)
  update(pausedByMain, rootPath, false)
  update(failedRequests, rootPath, false)
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

/** The deepest held root containing the file is the watch that serves it (worktree, folder or tab-folder watch). */
export function isLocalFileWatchPaused(filePath: string | null | undefined): boolean {
  if (!filePath) {
    return false
  }
  const fileKey = rootKey(filePath)
  let owner: string | null = null
  for (const key of heldRoots) {
    const contains = fileKey === key || fileKey.startsWith(key.endsWith('/') ? key : `${key}/`)
    if (contains && (owner === null || key.length > owner.length)) {
      owner = key
    }
  }
  return owner !== null && (pausedByMain.has(owner) || failedRequests.has(owner))
}

export function useLocalFileWatchPaused(filePath: string | null | undefined): boolean {
  // A boolean snapshot: unrelated roots changing state don't re-render this file's header.
  return useSyncExternalStore(
    subscribe,
    () => isLocalFileWatchPaused(filePath),
    () => false
  )
}

// Why at module load: the listener must exist before the first watchWorktree, whose pause push can arrive immediately.
if (typeof window !== 'undefined' && window.api?.fs?.onWatchPaused) {
  window.api.fs.onWatchPaused(applyLocalWatchPausedPayload)
}

export function __resetLocalWatchPauseStoreForTests(): void {
  pausedByMain.clear()
  failedRequests.clear()
  heldRoots.clear()
}
