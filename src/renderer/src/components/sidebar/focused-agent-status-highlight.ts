import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

export type FocusedAgentStatusHighlightState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabType'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
>

export function hasFocusedAgentStatusForWorktree(
  state: FocusedAgentStatusHighlightState,
  worktreeId: string,
  now = Date.now()
): boolean {
  if (state.activeWorktreeId !== worktreeId || state.activeTabType !== 'terminal') {
    return false
  }

  const activeTabId = state.activeTabId
  if (!activeTabId) {
    return false
  }

  const activeTabBelongsToWorktree = (state.tabsByWorktree[worktreeId] ?? []).some(
    (tab) => tab.id === activeTabId
  )
  if (!activeTabBelongsToWorktree) {
    return false
  }

  const activeLeafId = state.terminalLayoutsByTabId[activeTabId]?.activeLeafId
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return false
  }

  const activePaneKey = makePaneKey(activeTabId, activeLeafId)
  const liveEntry = state.agentStatusByPaneKey[activePaneKey]
  if (liveEntry && isFreshLiveAgent(liveEntry, now)) {
    return true
  }

  if (state.retainedAgentsByPaneKey[activePaneKey]?.worktreeId === worktreeId) {
    return true
  }

  return Object.values(state.migrationUnsupportedByPtyId).some(
    (entry) => entry.paneKey === activePaneKey
  )
}

export function useFocusedAgentStatusHighlight(worktreeId: string): boolean {
  return useAppStore((state) => hasFocusedAgentStatusForWorktree(state, worktreeId))
}

function isFreshLiveAgent(entry: AgentStatusEntry, now: number): boolean {
  return isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
}
