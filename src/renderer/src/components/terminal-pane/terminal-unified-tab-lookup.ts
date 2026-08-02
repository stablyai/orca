import type { Tab } from '../../../../shared/types'

const terminalTabLookupByUnifiedTabs = new WeakMap<readonly Tab[], Map<string, Tab>>()

export function getCachedUnifiedTerminalTabForWorktree(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  worktreeId: string,
  terminalTabId: string
): Tab | null {
  const unifiedTabs = unifiedTabsByWorktree[worktreeId]
  if (!unifiedTabs) {
    return null
  }

  let lookup = terminalTabLookupByUnifiedTabs.get(unifiedTabs)
  if (!lookup) {
    // Why: every retained TerminalPane reads this tab on every store update.
    // Share one immutable-array index instead of repeating linear scans.
    lookup = new Map()
    for (const tab of unifiedTabs) {
      if (tab.contentType === 'terminal') {
        lookup.set(tab.entityId, tab)
      }
    }
    terminalTabLookupByUnifiedTabs.set(unifiedTabs, lookup)
  }

  return lookup.get(terminalTabId) ?? null
}

export function getCachedTerminalGroupIdForWorktree(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  worktreeId: string,
  terminalTabId: string
): string | null {
  return (
    getCachedUnifiedTerminalTabForWorktree(unifiedTabsByWorktree, worktreeId, terminalTabId)
      ?.groupId ?? null
  )
}
