import type { Tab } from '../../../../shared/types'

const terminalGroupLookupByUnifiedTabs = new WeakMap<readonly Tab[], Map<string, string>>()

export function getCachedTerminalGroupIdForWorktree(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  worktreeId: string,
  terminalTabId: string
): string | null {
  const unifiedTabs = unifiedTabsByWorktree[worktreeId]
  if (!unifiedTabs) {
    return null
  }

  let lookup = terminalGroupLookupByUnifiedTabs.get(unifiedTabs)
  if (!lookup) {
    // Why: every mounted TerminalPane asks for its owning group on store updates.
    // Cache by immutable tab-array ref so 200 panes do not repeat the same scan.
    lookup = new Map()
    for (const tab of unifiedTabs) {
      if (tab.contentType === 'terminal') {
        lookup.set(tab.entityId, tab.groupId)
      }
    }
    terminalGroupLookupByUnifiedTabs.set(unifiedTabs, lookup)
  }

  return lookup.get(terminalTabId) ?? null
}
