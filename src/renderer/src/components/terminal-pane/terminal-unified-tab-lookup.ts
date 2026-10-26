import type { Tab } from '../../../../shared/tab-types'

export type UnifiedTerminalTabFields = {
  unifiedTabId: string | undefined
  isChatViewMode: boolean
  unifiedTabLabel: string | undefined
  isTabPinned: boolean
}

const terminalTabLookupByUnifiedTabs = new WeakMap<readonly Tab[], Map<string, Tab[]>>()

export function getCachedUnifiedTerminalTabForWorktree(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  worktreeId: string,
  terminalTabId: string
): Tab | null {
  const unifiedTabs = Object.hasOwn(unifiedTabsByWorktree, worktreeId)
    ? unifiedTabsByWorktree[worktreeId]
    : undefined
  if (!unifiedTabs) {
    return null
  }

  let lookup = terminalTabLookupByUnifiedTabs.get(unifiedTabs)
  if (!lookup) {
    // Share one immutable-array index across retained panes reading unified tabs on every write.
    lookup = new Map()
    for (const tab of unifiedTabs) {
      if (tab.contentType === 'terminal') {
        const items = lookup.get(tab.entityId) ?? []
        items.push(tab)
        lookup.set(tab.entityId, items)
      }
    }
    terminalTabLookupByUnifiedTabs.set(unifiedTabs, lookup)
  }

  return lookup.get(terminalTabId)?.at(-1) ?? null
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

/** Bundle formerly separate pane reads to avoid repeated lookups and listener slots per tab. */
export function selectUnifiedTerminalTabFields(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  worktreeId: string,
  terminalTabId: string
): UnifiedTerminalTabFields {
  const tab = getCachedUnifiedTerminalTabForWorktree(
    unifiedTabsByWorktree,
    worktreeId,
    terminalTabId
  )
  return {
    unifiedTabId: tab?.id,
    isChatViewMode: tab?.viewMode === 'chat',
    unifiedTabLabel: tab?.label,
    isTabPinned: tab?.isPinned === true
  }
}

export function getCachedUnifiedTerminalTabCandidates(
  source: Record<string, Tab[]>,
  worktreeId: string,
  terminalTabId: string
): readonly Tab[] {
  if (!Object.hasOwn(source, worktreeId)) {
    return []
  }
  getCachedUnifiedTerminalTabForWorktree(source, worktreeId, terminalTabId)
  return terminalTabLookupByUnifiedTabs.get(source[worktreeId])?.get(terminalTabId) ?? []
}
