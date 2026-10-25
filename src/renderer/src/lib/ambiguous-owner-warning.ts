// Why: activity bumps, persists and sweeps repeat on every event, so an ambiguous workspace would
// warn continuously. One line per workspace and caller is enough to diagnose it (#10634).
export const ambiguousOwnerWarnedWorktreeIds = new Map<string, Set<string>>()

/** Re-arms the once-per-workspace warnings; called from every worktree teardown path. */
export function forgetAmbiguousOwnerWarnings(worktreeIds: Iterable<string>): void {
  for (const worktreeId of worktreeIds) {
    ambiguousOwnerWarnedWorktreeIds.delete(worktreeId)
  }
}

export function warnAmbiguousOwnerOnce(worktreeId: string, skippedAction: string): void {
  const warned = ambiguousOwnerWarnedWorktreeIds.get(worktreeId) ?? new Set<string>()
  if (warned.has(skippedAction)) {
    return
  }
  ambiguousOwnerWarnedWorktreeIds.set(worktreeId, warned.add(skippedAction))
  console.warn(`Skipped ${skippedAction}: workspace identity is ambiguous across hosts`, worktreeId)
}
