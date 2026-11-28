import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import type { FsChangedPayload } from '../../../../../../shared/file-watch/filesystem-change-event'
import {
  forgetLocalWatchRoot,
  noteLocalWatchRootHeld,
  setLocalWatchRequestFailed
} from '../reload-from-disk/editor-watch-pause-store'

export type WatchRootArgs = { worktreePath: string; connectionId: string | undefined }

export function localWatchRoot(path: string): WatchRootArgs {
  return { worktreePath: path, connectionId: undefined }
}

/** 'deferred': main will install it when watcher capacity frees; 'failed': nothing is watching it. */
export type WatchRootStatus = 'pending' | 'watching' | 'deferred' | 'failed'

type HeldWatchRoot = {
  args: WatchRootArgs
  consumers: number
  installed: Promise<void>
  status: WatchRootStatus
  /** Bumped by each request and by release, so a superseded completion can't touch pause state. */
  requestGeneration: number
}

/** Local and SSH watch roots held by this renderer, counted per physical root. */
export type HeldWatchRoots = Map<string, HeldWatchRoot>

// Why: main keeps one listener per renderer and root, so two workspace ids on one directory must share one watch.
function getWatchRootKey(target: WatchRootArgs): string {
  return `${target.connectionId ?? 'local'}::${normalizeRuntimePathForComparison(target.worktreePath)}`
}

/** Resolves once the root's watch request has settled, including when another consumer started it. */
export function acquireWatchRoot(
  roots: HeldWatchRoots,
  target: WatchRootArgs,
  onError: (error: unknown) => void
): Promise<void> {
  const key = getWatchRootKey(target)
  const held = roots.get(key)
  if (held) {
    held.consumers += 1
    // Why: a failed request is not a watch; the next workspace to need this root retries it. A deferred one is already queued in main.
    if (held.status === 'failed') {
      requestWatch(held, onError)
    }
    return held.installed
  }
  const root: HeldWatchRoot = {
    args: { worktreePath: target.worktreePath, connectionId: target.connectionId },
    consumers: 1,
    installed: Promise.resolve(),
    status: 'pending',
    requestGeneration: 0
  }
  roots.set(key, root)
  if (root.args.connectionId === undefined) {
    noteLocalWatchRootHeld(root.args.worktreePath)
  }
  requestWatch(root, onError)
  return root.installed
}

export function watchRootStatus(
  roots: HeldWatchRoots,
  target: WatchRootArgs
): WatchRootStatus | undefined {
  return roots.get(getWatchRootKey(target))?.status
}

/** Re-requests a held root whose last request failed, without adding a consumer. */
export function retryFailedWatchRoot(
  roots: HeldWatchRoots,
  target: WatchRootArgs,
  onError: (error: unknown) => void
): Promise<void> | undefined {
  const held = roots.get(getWatchRootKey(target))
  if (held?.status !== 'failed') {
    return undefined
  }
  requestWatch(held, onError)
  return held.installed
}

/** Re-asks main about a settled root another consumer started, without adding a consumer. */
export function revalidateWatchRoot(
  roots: HeldWatchRoots,
  target: WatchRootArgs,
  onError: (error: unknown) => void
): Promise<void> | undefined {
  const held = roots.get(getWatchRootKey(target))
  if (!held || held.status === 'pending') {
    return undefined
  }
  requestWatch(held, onError)
  return held.installed
}

/** Main resyncs a root when a deferred install lands, but also after other catch-ups, so a deferred root re-asks. */
export function refreshDeferredWatchRoot(
  roots: HeldWatchRoots,
  target: WatchRootArgs,
  onError: (error: unknown) => void
): Promise<void> | undefined {
  const held = roots.get(getWatchRootKey(target))
  if (held?.status !== 'deferred') {
    return undefined
  }
  requestWatch(held, onError)
  return held.installed
}

function requestWatch(root: HeldWatchRoot, onError: (error: unknown) => void): void {
  root.status = 'pending'
  const generation = ++root.requestGeneration
  // Only the latest request of a still-held root speaks for this renderer's pause state.
  const isLocal = () =>
    root.args.connectionId === undefined && root.requestGeneration === generation
  root.installed = window.api.fs.watchWorktree(root.args).then(
    (result) => {
      // Why undefined is watching: remote roots and older mains resolve without an outcome.
      root.status =
        result === 'unavailable' ? 'failed' : result === 'deferred' ? 'deferred' : 'watching'
      // Main pushes deferred/unwatchable pauses itself; only a rejected request is ours to report.
      if (isLocal()) {
        setLocalWatchRequestFailed(root.args.worktreePath, false)
      }
    },
    (error: unknown) => {
      root.status = 'failed'
      // An unwatched local root has no auto-reload; the editor's reload control says so.
      if (isLocal()) {
        setLocalWatchRequestFailed(root.args.worktreePath, true)
      }
      onError(error)
    }
  )
}

/** With `onHandOver`, main returns the events it had queued for this window on that root, so a successor watch loses none. */
export function releaseWatchRoot(
  roots: HeldWatchRoots,
  target: WatchRootArgs,
  onHandOver?: (payload: FsChangedPayload) => void
): void {
  const key = getWatchRootKey(target)
  const held = roots.get(key)
  if (!held) {
    return
  }
  held.consumers -= 1
  if (held.consumers > 0) {
    return
  }
  roots.delete(key)
  forgetHeldLocalRoot(held)
  void window.api.fs.unwatchWorktree({ ...held.args, handOver: onHandOver !== undefined }).then(
    (undelivered) => undelivered && onHandOver?.(undelivered),
    // Why: a failed unwatch has nothing to hand over.
    () => undefined
  )
}

function forgetHeldLocalRoot(held: HeldWatchRoot): void {
  held.requestGeneration += 1
  if (held.args.connectionId === undefined) {
    forgetLocalWatchRoot(held.args.worktreePath)
  }
}

export function releaseAllWatchRoots(roots: HeldWatchRoots): void {
  for (const held of roots.values()) {
    forgetHeldLocalRoot(held)
    void window.api.fs.unwatchWorktree(held.args)
  }
  roots.clear()
}
