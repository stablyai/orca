import type { Tab } from '../../../../shared/tab-types'
import type { AgentType } from '../../../../shared/agent-status-types'

export type UnifiedTerminalTabChatFields = {
  unifiedTabId: string | undefined
  structuredSessionAgent: AgentType | undefined
  isChatViewMode: boolean
  structuredSessionId: string | null
  unifiedTabLabel: string | undefined
}

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

/**
 * The five unified-tab fields TerminalPane's chat state reads.
 *
 * Why bundled: they used to be five `useAppStore` calls, so one publication paid
 * the lookup five times and held five listener slots for every mounted tab.
 */
export function selectUnifiedTerminalTabChatFields(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  worktreeId: string,
  terminalTabId: string
): UnifiedTerminalTabChatFields {
  const tab = getCachedUnifiedTerminalTabForWorktree(
    unifiedTabsByWorktree,
    worktreeId,
    terminalTabId
  )
  return {
    unifiedTabId: tab?.id,
    structuredSessionAgent: tab?.agentSessionAgent,
    isChatViewMode: tab?.viewMode === 'chat',
    structuredSessionId: tab?.structuredSessionId ?? null,
    unifiedTabLabel: tab?.label
  }
}
