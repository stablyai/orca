export function addBackgroundMountedTerminalWorktree(
  mountedWorktreeIds: Set<string>,
  worktreeId: string | undefined,
  onAdded: () => void
): boolean {
  if (!worktreeId || mountedWorktreeIds.has(worktreeId)) {
    return false
  }
  mountedWorktreeIds.add(worktreeId)
  onAdded()
  return true
}
