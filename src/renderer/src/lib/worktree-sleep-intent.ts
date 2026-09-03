// Why: a slept workspace keeps its panes mounted with only dead PTYs behind them.
// Until the user explicitly opens it (or something binds a PTY to it), any
// remount of those panes must stay cold instead of reattaching or respawning.
const sleepingWorktreeIds = new Set<string>()

export function markWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.add(worktreeId)
}

export function clearWorktreeSleepIntent(worktreeId: string | null): void {
  if (worktreeId) {
    sleepingWorktreeIds.delete(worktreeId)
  }
}

export function hasWorktreeSleepIntent(worktreeId: string | null): boolean {
  return worktreeId !== null && sleepingWorktreeIds.has(worktreeId)
}
