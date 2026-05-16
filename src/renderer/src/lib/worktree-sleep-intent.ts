const sleepingWorktreeIds = new Set<string>()

export function markWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.add(worktreeId)
}

export function clearWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.delete(worktreeId)
}

export function hasWorktreeSleepIntent(worktreeId: string | null): boolean {
  return worktreeId !== null && sleepingWorktreeIds.has(worktreeId)
}
