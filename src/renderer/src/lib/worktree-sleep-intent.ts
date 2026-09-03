// Why: a slept workspace keeps its panes mounted with only dead PTYs behind them.
// Any pane connect that runs while the marker is set waits here, and the clear
// that marks the workspace awake resumes every waiting connect.
const sleepingWorktreeIds = new Set<string>()
const wakeListenersByWorktreeId = new Map<string, Set<() => void>>()

export function markWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.add(worktreeId)
}

export function clearWorktreeSleepIntent(worktreeId: string | null): void {
  if (!worktreeId || !sleepingWorktreeIds.delete(worktreeId)) {
    return
  }
  const listeners = wakeListenersByWorktreeId.get(worktreeId)
  wakeListenersByWorktreeId.delete(worktreeId)
  for (const listener of listeners ?? []) {
    listener()
  }
}

// Why: a purged worktree must not wake its panes; they are being unmounted.
export function forgetWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.delete(worktreeId)
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
