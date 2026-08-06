let explicitForegroundTerminalTabIds = new Set<string>()
const visibleTerminalTabClaimsByToken = new Map<symbol, string>()
const foregroundTerminalTabLastSeenAtById = new Map<string, number>()

function normalizeTerminalTabIds(tabIds: Iterable<string | null | undefined>): Set<string> {
  return new Set(
    Array.from(tabIds).filter(
      (tabId): tabId is string => typeof tabId === 'string' && tabId.length > 0
    )
  )
}

export function setForegroundTerminalTabIds(tabIds: Iterable<string | null | undefined>): void {
  const previousForegroundTerminalTabIds = new Set(getForegroundTerminalTabIds())
  explicitForegroundTerminalTabIds = normalizeTerminalTabIds(tabIds)
  const now = Date.now()
  for (const tabId of explicitForegroundTerminalTabIds) {
    foregroundTerminalTabLastSeenAtById.set(tabId, now)
  }
  refreshExitedForegroundTerminalTabLastSeen(previousForegroundTerminalTabIds, now)
}

export function registerVisibleTerminalTab(tabId: string | null | undefined): () => void {
  const normalized = normalizeTerminalTabIds([tabId])
  const id = Array.from(normalized)[0]
  if (!id) {
    return () => {}
  }

  // Why: multiple visible panes can belong to one terminal tab; tokenized claims
  // let each pane clean up without dropping sibling foreground protection.
  const token = Symbol(id)
  visibleTerminalTabClaimsByToken.set(token, id)
  foregroundTerminalTabLastSeenAtById.set(id, Date.now())
  return () => {
    if (!visibleTerminalTabClaimsByToken.delete(token)) {
      return
    }
    if (!getForegroundTerminalTabIds().includes(id)) {
      // Why: keep the sleep timer anchored to the end of the full foreground visit.
      foregroundTerminalTabLastSeenAtById.set(id, Date.now())
    }
  }
}

export function getForegroundTerminalTabIds(): string[] {
  // Why: hibernation already reasons by terminal tab, so visible pane claims
  // join the page-level foreground set instead of adding pane rules.
  return Array.from(
    new Set([...explicitForegroundTerminalTabIds, ...visibleTerminalTabClaimsByToken.values()])
  )
}

export function getForegroundTerminalTabLastSeenAtById(): Record<string, number> {
  return Object.fromEntries(foregroundTerminalTabLastSeenAtById)
}

// Why: retired terminal tab ids never recur, so their last-seen timestamps would
// accumulate for the renderer's whole session. Drop them when a tab is closed or
// its worktree is removed (mirrors forgetAgentHibernationTabOutput).
export function forgetForegroundTerminalTabs(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    foregroundTerminalTabLastSeenAtById.delete(tabId)
  }
}

export function resetForegroundTerminalTabIdsForTests(): void {
  explicitForegroundTerminalTabIds = new Set()
  visibleTerminalTabClaimsByToken.clear()
  foregroundTerminalTabLastSeenAtById.clear()
}

function refreshExitedForegroundTerminalTabLastSeen(
  previousForegroundTerminalTabIds: Set<string>,
  now: number
): void {
  const currentForegroundTerminalTabIds = new Set(getForegroundTerminalTabIds())
  for (const tabId of previousForegroundTerminalTabIds) {
    if (!currentForegroundTerminalTabIds.has(tabId)) {
      // Why: visible panes can keep a terminal tab foreground after explicit ids change.
      foregroundTerminalTabLastSeenAtById.set(tabId, now)
    }
  }
}
