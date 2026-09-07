import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

type RecoveryResult = RuntimeMobileSessionTabsResult | null
type RecoveryRunner = (isCurrent: () => boolean) => Promise<RecoveryResult>

type QueuedRecovery = {
  run: RecoveryRunner
  resolve: (value: RecoveryResult) => void
}

type ActiveRecovery = {
  superseded: boolean
  promise: Promise<RecoveryResult>
}

type RecoveryQueue = {
  active?: ActiveRecovery
  queued?: QueuedRecovery
}

const recoveryQueues = new Map<string, RecoveryQueue>()

function startRecovery(
  key: string,
  queue: RecoveryQueue,
  run: RecoveryRunner
): Promise<RecoveryResult> {
  const active: ActiveRecovery = {
    superseded: false,
    promise: Promise.resolve(null)
  }
  const promise = run(() => !active.superseded).catch(() => null)
  active.promise = promise
  queue.active = active
  void promise.then(() => {
    if (recoveryQueues.get(key) !== queue || queue.active !== active) {
      return
    }
    queue.active = undefined
    const queued = queue.queued
    queue.queued = undefined
    if (!queued) {
      recoveryQueues.delete(key)
      return
    }
    const next = startRecovery(key, queue, queued.run)
    void next.then(queued.resolve, () => queued.resolve(null))
  })
  return promise
}

/** Runs one recovery and keeps only the newest trailing frame. */
export function enqueueLatestTerminalRecovery(
  key: string,
  run: RecoveryRunner
): Promise<RecoveryResult> {
  const queue = recoveryQueues.get(key) ?? {}
  recoveryQueues.set(key, queue)
  if (!queue.active) {
    return startRecovery(key, queue, run)
  }
  // A newer frame owns the key; let the in-flight operation finish its RPC but discard its result.
  queue.active.superseded = true
  queue.queued?.resolve(null)
  return new Promise((resolve) => {
    queue.queued = { run, resolve }
  })
}

/** Supersedes a degraded operation when a ready/removal frame arrives. */
export function supersedeTerminalRecovery(key: string): void {
  const queue = recoveryQueues.get(key)
  if (!queue) {
    return
  }
  if (queue.active) {
    queue.active.superseded = true
  }
  if (queue.queued) {
    queue.queued.resolve(null)
  }
  queue.queued = undefined
  if (!queue.active) {
    recoveryQueues.delete(key)
  }
}

export function clearTerminalRecoveryQueues(): void {
  for (const queue of recoveryQueues.values()) {
    if (queue.active) {
      queue.active.superseded = true
    }
    if (queue.queued) {
      queue.queued.resolve(null)
    }
  }
  recoveryQueues.clear()
}
