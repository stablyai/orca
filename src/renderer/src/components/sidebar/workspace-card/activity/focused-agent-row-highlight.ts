import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/tab-types'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../../shared/workspace-layout/stable-pane-id'

export type FocusedAgentRowHighlightState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabType'
  | 'activeTabId'
  | 'getActiveTab'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
>

// This selector runs per row on every store update, and the pane key is a hash.
const chatPaneKeyByTab = new WeakMap<Tab, string>()

function chatPaneKey(tab: Tab): string {
  let paneKey = chatPaneKeyByTab.get(tab)
  if (!paneKey) {
    paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    chatPaneKeyByTab.set(tab, paneKey)
  }
  return paneKey
}

function getActivePaneKeyForWorktree(
  state: FocusedAgentRowHighlightState,
  worktreeId: string
): string | null {
  if (state.activeTabType === 'agent-session') {
    const activeTab = state.getActiveTab(worktreeId)
    return activeTab?.contentType === 'agent-session' ? chatPaneKey(activeTab) : null
  }
  if (state.activeTabType !== 'terminal') {
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

  return makePaneKey(activeTabId, activeLeafId)
}

export function getFocusedAgentPaneKeyForWorktree(
  state: FocusedAgentRowHighlightState,
  worktreeId: string
): string | null {
  if (state.activeWorktreeId !== worktreeId) {
    return null
  }

  const activePaneKey = getActivePaneKeyForWorktree(state, worktreeId)
  if (!activePaneKey) {
    return null
  }

  // Stale agents remain visible, so their focused rows must still highlight.
  if (state.agentStatusByPaneKey.get(activePaneKey)) {
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
