let explicitForegroundWorktreeIds = new Set<string>()
const visibleTerminalClaimsByToken = new Map<symbol, string>()
const foregroundTerminalWorktreeLastSeenAtById = new Map<string, number>()

function normalizeWorktreeIds(worktreeIds: Iterable<string | null | undefined>): Set<string> {
  return new Set(
    Array.from(worktreeIds).filter(
      (worktreeId): worktreeId is string => typeof worktreeId === 'string' && worktreeId.length > 0
    )
  )
}

export function setForegroundTerminalWorktreeIds(
  worktreeIds: Iterable<string | null | undefined>
): void {
  const previousForegroundWorktreeIds = new Set(getForegroundTerminalWorktreeIds())
  explicitForegroundWorktreeIds = normalizeWorktreeIds(worktreeIds)
  const now = Date.now()
  for (const worktreeId of explicitForegroundWorktreeIds) {
    foregroundTerminalWorktreeLastSeenAtById.set(worktreeId, now)
  }
  refreshExitedForegroundWorktreeLastSeen(previousForegroundWorktreeIds, now)
}

export function registerVisibleTerminalWorktree(worktreeId: string | null | undefined): () => void {
  const normalized = normalizeWorktreeIds([worktreeId])
  const id = Array.from(normalized)[0]
  if (!id) {
    return () => {}
  }

  // Why: multiple visible panes can belong to one worktree; tokenized claims
  // let each pane clean up without dropping sibling foreground protection.
  const token = Symbol(id)
  visibleTerminalClaimsByToken.set(token, id)
  foregroundTerminalWorktreeLastSeenAtById.set(id, Date.now())
  return () => {
    if (!visibleTerminalClaimsByToken.delete(token)) {
      return
    }
    if (!getForegroundTerminalWorktreeIds().includes(id)) {
      // Why: keep the sleep timer anchored to the end of the full foreground visit.
      foregroundTerminalWorktreeLastSeenAtById.set(id, Date.now())
    }
  }
}

export function getForegroundTerminalWorktreeIds(): string[] {
  // Why: hibernation already gates by foreground worktree, so visible pane
  // claims join the page-level foreground set instead of adding pane rules.
  return Array.from(
    new Set([...explicitForegroundWorktreeIds, ...visibleTerminalClaimsByToken.values()])
  )
}

export function getForegroundTerminalWorktreeLastSeenAtById(): Record<string, number> {
  return Object.fromEntries(foregroundTerminalWorktreeLastSeenAtById)
}

export function resetForegroundTerminalWorktreeIdsForTests(): void {
  explicitForegroundWorktreeIds = new Set()
  visibleTerminalClaimsByToken.clear()
  foregroundTerminalWorktreeLastSeenAtById.clear()
}

function refreshExitedForegroundWorktreeLastSeen(
  previousForegroundWorktreeIds: Set<string>,
  now: number
): void {
  const currentForegroundWorktreeIds = new Set(getForegroundTerminalWorktreeIds())
  for (const worktreeId of previousForegroundWorktreeIds) {
    if (!currentForegroundWorktreeIds.has(worktreeId)) {
      // Why: visible panes can keep a worktree foreground after explicit ids change.
      foregroundTerminalWorktreeLastSeenAtById.set(worktreeId, now)
    }
  }
}
