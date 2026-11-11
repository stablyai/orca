import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { getAgentPaneExecutionHost } from '../agent-status/agent-pane-execution-host'
import { workspaceMarkerTabs, type MarkerTab } from './workspace-live-markers'

function markerTabHost(state: AppState, workspaceId: string, tab: MarkerTab) {
  const terminal = state.tabsByWorktree[workspaceId]?.find((candidate) => candidate.id === tab.id)
  const layout = state.terminalLayoutsByTabId[tab.id]
  const paneKey =
    tab.sessionId === null
      ? `${tab.id}:${layout?.activeLeafId ?? ''}`
      : structuredAgentSessionPaneKey(tab.id, tab.sessionId)
  const entry = state.agentStatusByPaneKey[paneKey]
  const ptyId =
    (layout?.activeLeafId ? layout.ptyIdsByLeafId?.[layout.activeLeafId] : undefined) ??
    terminal?.ptyId ??
    state.ptyIdsByTabId[tab.id]?.[0]
  if (tab.sessionId === null && !entry && !ptyId) {
    const stampedHost = state.unifiedTabsByWorktree[workspaceId]?.find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tab.id
    )?.executionHostId
    if (stampedHost) {
      return stampedHost
    }
  }
  return getAgentPaneExecutionHost(state, paneKey, entry, ptyId)
}

/** Filter before removing markers or resolving jumps: workspace IDs can name several hosts. */
export function workspaceMarkerTabIdsForHost(
  state: AppState,
  workspaceId: string,
  executionHostId: ExecutionHostId | undefined
): Set<string> {
  return new Set(
    workspaceMarkerTabs(state, workspaceId)
      .filter(
        (tab) =>
          executionHostId === undefined ||
          markerTabHost(state, workspaceId, tab) === executionHostId
      )
      .map((tab) => tab.id)
  )
}
