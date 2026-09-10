import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  unwrapRuntimeRpcResult
} from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

type RuntimeFileWatchEvent =
  | { type: 'starting'; subscriptionId: string }
  | { type: 'ready'; subscriptionId: string }
  | { type: 'changed'; worktree: string; events: FsChangedPayload['events'] }
  | { type: 'error'; message: string }
  | { type: 'end' }

type RuntimeFileWatchListener = {
  onPayload: (payload: FsChangedPayload) => void
  onError?: (error: Error) => void
}

type SharedRuntimeFileWatch = {
  target: { kind: 'environment'; environmentId: string }
  worktreeId: string
  listeners: Set<RuntimeFileWatchListener>
  start: Promise<void>
  unsubscribe: (() => void) | null
  remoteSubscriptionId: string | null
  keepStreamUntilReady: boolean
  closed: boolean
}

const sharedRuntimeFileWatches = new Map<string, SharedRuntimeFileWatch>()

function getSharedRuntimeFileWatchKey(
  environmentId: string,
  worktreeId: string,
  worktreePath: string
): string {
  return `${environmentId}\0${worktreeId}\0${worktreePath}`
}

export async function subscribeRuntimeFileChanges(
  context: RuntimeFileOperationArgs,
  onPayload: (payload: FsChangedPayload) => void,
  onError?: (error: Error) => void
): Promise<() => void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId || !context.worktreePath) {
    return window.api.fs.onFsChanged(onPayload)
  }

  const listener: RuntimeFileWatchListener = { onPayload, onError }
  const key = getSharedRuntimeFileWatchKey(
    target.environmentId,
    context.worktreeId,
    context.worktreePath
  )
  let shared = sharedRuntimeFileWatches.get(key)
  if (!shared) {
    shared = createSharedRuntimeFileWatch(key, target, context.worktreeId, context.worktreePath)
    sharedRuntimeFileWatches.set(key, shared)
  }
  shared.listeners.add(listener)
  try {
    await shared.start
  } catch (err) {
    shared.listeners.delete(listener)
    throw err
  }

  return () => {
    const current = sharedRuntimeFileWatches.get(key)
    if (!current) {
      return
    }
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      closeSharedRuntimeFileWatch(key, current)
    }
  }
}

function createSharedRuntimeFileWatch(
  key: string,
  target: { kind: 'environment'; environmentId: string },
  worktreeId: string,
  worktreePath: string
): SharedRuntimeFileWatch {
  const shared: SharedRuntimeFileWatch = {
    target,
    worktreeId,
    listeners: new Set(),
    start: Promise.resolve(),
    unsubscribe: null,
    remoteSubscriptionId: null,
    keepStreamUntilReady: isWebRuntimeFileWatchSharedSocket(),
    closed: false
  }
  // Why: editor reloads and the Explorer can watch the same remote worktree.
  // Keep one runtime WebSocket/server watcher and fan out events in renderer.
  shared.start = window.api.runtimeEnvironments
    .subscribe(
      {
        selector: target.environmentId,
        method: 'files.watch',
        params: { worktree: toRuntimeWorktreeSelector(worktreeId) },
        timeoutMs: 15_000
      },
      {
        onResponse: (response) => {
          handleSharedRuntimeFileWatchResponse(key, shared, worktreePath, response)
        },
        onError: (error) => {
          failSharedRuntimeFileWatch(key, shared, new Error(error.message))
        },
        onClose: () => {
          if (sharedRuntimeFileWatches.get(key) === shared) {
            sharedRuntimeFileWatches.delete(key)
          }
          shared.closed = true
          shared.unsubscribe = null
        }
      }
    )
    .then((subscription) => {
      shared.unsubscribe = subscription.unsubscribe
      if (shared.closed || sharedRuntimeFileWatches.get(key) !== shared) {
        subscription.unsubscribe()
        shared.unsubscribe = null
        if (!shared.keepStreamUntilReady) {
          unwatchSharedRuntimeFileWatch(shared)
        }
      }
    })
    .catch((err) => {
      failSharedRuntimeFileWatch(key, shared, err instanceof Error ? err : new Error(String(err)))
      throw err
    })
  return shared
}

function handleSharedRuntimeFileWatchResponse(
  key: string,
  shared: SharedRuntimeFileWatch,
  worktreePath: string,
  response: unknown
): void {
  try {
    const event = unwrapRuntimeRpcResult<RuntimeFileWatchEvent>(
      response as RuntimeRpcResponse<RuntimeFileWatchEvent>
    )
    if (event.type === 'starting' || event.type === 'ready') {
      shared.remoteSubscriptionId = event.subscriptionId
      if (shared.closed) {
        shared.unsubscribe?.()
        shared.unsubscribe = null
        if (!shared.keepStreamUntilReady) {
          unwatchSharedRuntimeFileWatch(shared)
        }
      }
    } else if (event.type === 'changed') {
      for (const listener of Array.from(shared.listeners)) {
        listener.onPayload({ worktreePath, events: event.events })
      }
    } else if (event.type === 'error') {
      // Why: error listeners may synchronously retry. Evict the terminal watch
      // before callbacks run so the retry cannot join a stream awaiting `end`.
      failSharedRuntimeFileWatch(key, shared, new Error(event.message))
    } else if (event.type === 'end') {
      // Why: shared-control completes without onClose; evict and release its
      // transport handle so later listeners start cleanly without retained state.
      if (sharedRuntimeFileWatches.get(key) === shared) {
        sharedRuntimeFileWatches.delete(key)
      }
      shared.closed = true
      const unsubscribe = shared.unsubscribe
      shared.unsubscribe = null
      shared.remoteSubscriptionId = null
      shared.listeners.clear()
      unsubscribe?.()
    }
  } catch (err) {
    failSharedRuntimeFileWatch(key, shared, err instanceof Error ? err : new Error(String(err)))
  }
}

function failSharedRuntimeFileWatch(
  key: string,
  shared: SharedRuntimeFileWatch,
  error: Error
): void {
  if (sharedRuntimeFileWatches.get(key) === shared) {
    sharedRuntimeFileWatches.delete(key)
  }
  shared.closed = true
  shared.remoteSubscriptionId = null
  const unsubscribe = shared.unsubscribe
  shared.unsubscribe = null
  const listeners = Array.from(shared.listeners)
  shared.listeners.clear()
  unsubscribe?.()
  for (const listener of listeners) {
    listener.onError?.(error)
  }
}

function closeSharedRuntimeFileWatch(key: string, shared: SharedRuntimeFileWatch): void {
  if (shared.closed) {
    return
  }
  shared.closed = true
  sharedRuntimeFileWatches.delete(key)
  if (shared.keepStreamUntilReady) {
    // Why: WebRuntimeClient owns shared-socket file-watch cleanup, including
    // pre-ready cancellation ownership and late-ready files.unwatch.
    shared.unsubscribe?.()
    shared.unsubscribe = null
    return
  }
  shared.unsubscribe?.()
  shared.unsubscribe = null
  unwatchSharedRuntimeFileWatch(shared)
}

function isWebRuntimeFileWatchSharedSocket(): boolean {
  return Boolean((globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

function unwatchSharedRuntimeFileWatch(shared: SharedRuntimeFileWatch): void {
  if (!shared.remoteSubscriptionId) {
    return
  }
  void callRuntimeRpc(
    shared.target,
    'files.unwatch',
    { subscriptionId: shared.remoteSubscriptionId },
    { timeoutMs: 5_000 }
  ).catch(() => {})
}
