// Slept panes stay mounted behind dead PTYs. Connects wait on this marker until wake clears it.
const sleepingWorktreeIds = new Set<string>()
const tearingDownWorktreeIds = new Set<string>()
const wakeListenersByWorktreeId = new Map<string, Set<() => void>>()

export function markWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.add(worktreeId)
}

// Spawns resolving during host teardown must not clear sleep and wake waiting panes; these binds are not wakes.
export async function withWorktreeSleepTeardown<T>(
  worktreeId: string,
  teardown: () => Promise<T>
): Promise<T> {
  tearingDownWorktreeIds.add(worktreeId)
  try {
    return await teardown()
  } finally {
    tearingDownWorktreeIds.delete(worktreeId)
  }
}

export function clearWorktreeSleepIntent(worktreeId: string | null): void {
  if (!worktreeId || tearingDownWorktreeIds.has(worktreeId)) {
    return
  }
  if (!sleepingWorktreeIds.delete(worktreeId)) {
    return
  }
  const listeners = wakeListenersByWorktreeId.get(worktreeId)
  wakeListenersByWorktreeId.delete(worktreeId)
  for (const listener of listeners ?? []) {
    try {
      listener()
    } catch (error) {
      // One failed connect must not strand siblings or escape a store action.
      console.error('[sleep-intent] wake listener failed', { worktreeId, error })
    }
  }
}

// Why: a purged worktree must not wake its panes; they are being unmounted.
export function forgetWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.delete(worktreeId)
  tearingDownWorktreeIds.delete(worktreeId)
  wakeListenersByWorktreeId.delete(worktreeId)
}

export function hasWorktreeSleepIntent(worktreeId: string | null): boolean {
  return worktreeId !== null && sleepingWorktreeIds.has(worktreeId)
}

export function onWorktreeSleepIntentCleared(worktreeId: string, listener: () => void): () => void {
  const listeners = wakeListenersByWorktreeId.get(worktreeId) ?? new Set<() => void>()
  listeners.add(listener)
  wakeListenersByWorktreeId.set(worktreeId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && wakeListenersByWorktreeId.get(worktreeId) === listeners) {
      wakeListenersByWorktreeId.delete(worktreeId)
    }
  }
}
