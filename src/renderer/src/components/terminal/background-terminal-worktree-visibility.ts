import { addBackgroundMountedTerminalWorktree } from './background-terminal-worktree-mount'

export const BACKGROUND_WORKTREE_MEASURE_WINDOW_MS = 3000

type ScheduleMeasureArgs = {
  mountedWorktreeIds: Set<string>
  measurableBackgroundWorktreeIds: Set<string>
  timers: Map<string, number>
  worktreeId: string | undefined
  onRevision: () => void
  setTimeoutFn: typeof window.setTimeout
  clearTimeoutFn: typeof window.clearTimeout
}

export function scheduleBackgroundTerminalWorktreeMeasure({
  mountedWorktreeIds,
  measurableBackgroundWorktreeIds,
  timers,
  worktreeId,
  onRevision,
  setTimeoutFn,
  clearTimeoutFn
}: ScheduleMeasureArgs): boolean {
  const added = addBackgroundMountedTerminalWorktree(mountedWorktreeIds, worktreeId, onRevision)
  if (!worktreeId) {
    return added
  }

  measurableBackgroundWorktreeIds.add(worktreeId)
  const existingTimer = timers.get(worktreeId)
  if (existingTimer !== undefined) {
    clearTimeoutFn(existingTimer)
  }

  // Why: background renderer-backed terminal creation must be measurable for the
  // first xterm fit (the fit flushes the eager PTY buffer), but it must not keep
  // hidden worktrees laid out indefinitely after the PTY has started.
  const timer = setTimeoutFn(() => {
    measurableBackgroundWorktreeIds.delete(worktreeId)
    timers.delete(worktreeId)
    onRevision()
  }, BACKGROUND_WORKTREE_MEASURE_WINDOW_MS)

  timers.set(worktreeId, timer)
  onRevision()
  return added
}
