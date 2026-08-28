// Why: a slept workspace keeps its panes mounted, so an ambient deferred connect can
// respawn its PTY and silently wake it (#10205). The mark outlives the sleep teardown
// and is cleared only by an explicit activation or background wake, which is what tells
// a deliberate sleep apart from a tab that simply has no PTY yet.
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
