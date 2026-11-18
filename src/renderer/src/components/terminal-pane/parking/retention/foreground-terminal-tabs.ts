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

  // Tokenize visible-pane claims so one pane’s cleanup cannot drop a sibling’s foreground protection.
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
  // Merge pane claims into tab-level protection because hibernation reasons by terminal tab.
  return Array.from(
    new Set([...explicitForegroundTerminalTabIds, ...visibleTerminalTabClaimsByToken.values()])
  )
}

export function getForegroundTerminalTabLastSeenAtById(): Record<string, number> {
  return Object.fromEntries(foregroundTerminalTabLastSeenAtById)
}

// Purge retired tab timestamps on tab/worktree removal; IDs never recur and would otherwise accumulate all session.
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
