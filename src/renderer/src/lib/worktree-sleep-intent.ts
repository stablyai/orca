import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'

type SleepIntent = { worktreeId: string; hostId: ExecutionHostId }
const intents = new Map<string, SleepIntent>()
const teardownCounts = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
const keyFor = (worktreeId: string, hostId: ExecutionHostId): string => `${hostId}\0${worktreeId}`

function matchingKeys(worktreeId: string, hostId?: ExecutionHostId): string[] {
  return hostId
    ? [keyFor(worktreeId, hostId)]
    : [...intents].filter(([, intent]) => intent.worktreeId === worktreeId).map(([key]) => key)
}

function notifyCleared(key: string, worktreeId: string): void {
  const keyListeners = [...(listeners.get(key) ?? [])]
  listeners.delete(key)
  const allHostsCleared = !matchingKeys(worktreeId).length && !hasWorktreeSleepTeardown(worktreeId)
  const worktreeListeners = allHostsCleared ? [...(listeners.get(worktreeId) ?? [])] : []
  if (allHostsCleared) {
    listeners.delete(worktreeId)
  }
  for (const listener of [...keyListeners, ...worktreeListeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[sleep-intent] wake listener failed', { worktreeId, error })
    }
  }
}

export function markWorktreeSleepIntent(
  worktreeId: string,
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): SleepIntent {
  const key = keyFor(worktreeId, hostId)
  const intent = { worktreeId, hostId }
  intents.set(key, intent)
  return intent
}

export function isCurrentWorktreeSleepIntent(
  worktreeId: string,
  hostId: ExecutionHostId,
  intent: SleepIntent
): boolean {
  return intents.get(keyFor(worktreeId, hostId)) === intent
}

export async function withWorktreeSleepTeardown<T>(
  worktreeId: string,
  teardown: () => Promise<T>,
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): Promise<T> {
  const finish = beginWorktreeSleepTeardown(worktreeId, hostId)
  try {
    return await teardown()
  } finally {
    finish()
  }
}

export function beginWorktreeSleepTeardown(
  worktreeId: string,
  hostId: ExecutionHostId
): () => void {
  const key = keyFor(worktreeId, hostId)
  teardownCounts.set(key, (teardownCounts.get(key) ?? 0) + 1)
  let finished = false
  return () => {
    if (finished) {
      return
    }
    finished = true
    const remaining = (teardownCounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      teardownCounts.set(key, remaining)
    } else {
      teardownCounts.delete(key)
      if (!intents.has(key)) {
        notifyCleared(key, worktreeId)
      }
    }
  }
}

export function clearWorktreeSleepIntent(
  worktreeId: string | null,
  hostId?: ExecutionHostId,
  source: 'wake' | 'bind' = 'wake'
): void {
  if (!worktreeId) {
    return
  }
  for (const key of matchingKeys(worktreeId, hostId)) {
    const intent = intents.get(key)
    if (!intent || (source === 'bind' && (teardownCounts.get(key) ?? 0) > 0)) {
      continue
    }
    intents.delete(key)
    if (!teardownCounts.has(key)) {
      notifyCleared(key, worktreeId)
    }
  }
}

export function forgetWorktreeSleepIntent(worktreeId: string): void {
  for (const key of matchingKeys(worktreeId)) {
    intents.delete(key)
    teardownCounts.delete(key)
    listeners.delete(key)
  }
  listeners.delete(worktreeId)
}

export function hasWorktreeSleepIntent(
  worktreeId: string | null,
  hostId?: ExecutionHostId
): boolean {
  return worktreeId !== null && matchingKeys(worktreeId, hostId).some((key) => intents.has(key))
}

export function hasWorktreeSleepTeardown(
  worktreeId: string | null,
  hostId?: ExecutionHostId
): boolean {
  if (worktreeId === null) {
    return false
  }
  return hostId
    ? teardownCounts.has(keyFor(worktreeId, hostId))
    : [...teardownCounts.keys()].some((key) => key.endsWith(`\0${worktreeId}`))
}

export function onWorktreeSleepIntentCleared(
  worktreeId: string,
  listener: () => void,
  hostId?: ExecutionHostId
): () => void {
  const key = hostId ? keyFor(worktreeId, hostId) : worktreeId
  const group = listeners.get(key) ?? new Set<() => void>()
  group.add(listener)
  listeners.set(key, group)
  return () => {
    group.delete(listener)
    if (group.size === 0 && listeners.get(key) === group) {
      listeners.delete(key)
    }
  }
}
