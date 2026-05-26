import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

export type FocusedAgentRowHighlightState = Pick<
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

export function getFocusedAgentPaneKeyForWorktree(
  state: FocusedAgentRowHighlightState,
  worktreeId: string,
  now = Date.now()
): string | null {
  if (state.activeWorktreeId !== worktreeId || state.activeTabType !== 'terminal') {
    return null
  }

  const activeTabId = state.activeTabId
  if (!activeTabId) {
    return null
  }

  const activeTabBelongsToWorktree = (state.tabsByWorktree[worktreeId] ?? []).some(
    (tab) => tab.id === activeTabId
  )
  if (!activeTabBelongsToWorktree) {
    return null
  }

  const activeLeafId = state.terminalLayoutsByTabId[activeTabId]?.activeLeafId
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return null
  }

  const activePaneKey = makePaneKey(activeTabId, activeLeafId)
  const liveEntry = state.agentStatusByPaneKey[activePaneKey]
  if (liveEntry && isFreshLiveAgent(liveEntry, now)) {
    return activePaneKey
  }

  if (state.retainedAgentsByPaneKey[activePaneKey]?.worktreeId === worktreeId) {
    return activePaneKey
  }

  const hasMigrationUnsupportedRow = Object.values(state.migrationUnsupportedByPtyId).some(
    (entry) => entry.paneKey === activePaneKey
  )
  return hasMigrationUnsupportedRow ? activePaneKey : null
}

export function useFocusedAgentPaneKey(worktreeId: string): string | null {
  return useAppStore((state) => getFocusedAgentPaneKeyForWorktree(state, worktreeId))
}

function isFreshLiveAgent(entry: AgentStatusEntry, now: number): boolean {
  return isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
}
