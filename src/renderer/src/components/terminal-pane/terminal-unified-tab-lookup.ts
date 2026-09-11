import type { Tab } from '../../../../shared/tab-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'

export type UnifiedTerminalTabChatFields = {
  unifiedTabId: string | undefined
  structuredSessionAgent: AgentType | undefined
  isChatViewMode: boolean
  structuredSessionId: string | null
  unifiedTabLabel: string | undefined
  /** Owner stamp of the chat this terminal tab hosts; kept as scalars so the shallow selector holds. */
  structuredSessionOwnerHostId: ExecutionHostId | undefined
  structuredSessionOwnerPairingRevision: number | undefined
  /** Legacy fallback for a tab persisted before stamping; the pane overlay uses the same one. */
  fallbackRuntimeEnvironmentId: string | null
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
 * The unified-tab fields TerminalPane's chat state reads.
 *
 * Why bundled: they used to be five `useAppStore` calls, so one publication paid
 * the lookup five times and held five listener slots for every mounted tab.
 */
export function selectUnifiedTerminalTabChatFields(
  state: WorktreeRuntimeOwnerState & { unifiedTabsByWorktree: Record<string, Tab[]> },
  worktreeId: string,
  terminalTabId: string
): UnifiedTerminalTabChatFields {
  const tab = getCachedUnifiedTerminalTabForWorktree(
    state.unifiedTabsByWorktree,
    worktreeId,
    terminalTabId
  )
  return {
    unifiedTabId: tab?.id,
    structuredSessionAgent: tab?.agentSessionAgent,
    isChatViewMode: tab?.viewMode === 'chat',
    structuredSessionId: tab?.structuredSessionId ?? null,
    unifiedTabLabel: tab?.label,
    structuredSessionOwnerHostId: tab?.executionHostId,
    structuredSessionOwnerPairingRevision: tab?.runtimeOwnerPairingRevision,
    fallbackRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}
