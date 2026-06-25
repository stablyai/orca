let explicitForegroundWorktreeIds = new Set<string>()
const visibleTerminalClaimsByToken = new Map<symbol, string>()

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
  explicitForegroundWorktreeIds = normalizeWorktreeIds(worktreeIds)
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
  return () => {
    visibleTerminalClaimsByToken.delete(token)
  }
}

export function getForegroundTerminalWorktreeIds(): string[] {
  // Why: hibernation already gates by foreground worktree, so visible pane
  // claims join the page-level foreground set instead of adding pane rules.
  return Array.from(
    new Set([...explicitForegroundWorktreeIds, ...visibleTerminalClaimsByToken.values()])
  )
}

export function resetForegroundTerminalWorktreeIdsForTests(): void {
  explicitForegroundWorktreeIds = new Set()
  visibleTerminalClaimsByToken.clear()
}
