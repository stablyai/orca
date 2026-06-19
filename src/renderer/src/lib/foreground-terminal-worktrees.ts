let foregroundWorktreeIds = new Set<string>()

export function setForegroundTerminalWorktreeIds(
  worktreeIds: Iterable<string | null | undefined>
): void {
  foregroundWorktreeIds = new Set(
    Array.from(worktreeIds).filter(
      (worktreeId): worktreeId is string => typeof worktreeId === 'string' && worktreeId.length > 0
    )
  )
}

export function getForegroundTerminalWorktreeIds(): string[] {
  return Array.from(foregroundWorktreeIds)
}

export function resetForegroundTerminalWorktreeIdsForTests(): void {
  foregroundWorktreeIds = new Set()
}
