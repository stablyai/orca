import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
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
  worktreeId: string
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
  // Why: the inline card lists every agent attributed to this worktree, even
  // after its status decays to idle. Highlight whichever displayed row matches
  // the focused pane — gating on freshness left clicked-into stale rows with no
  // selection coloring.
  if (state.agentStatusByPaneKey[activePaneKey]) {
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
