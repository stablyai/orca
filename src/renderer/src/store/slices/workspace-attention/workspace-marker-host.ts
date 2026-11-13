import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { getAgentPaneExecutionHost } from '../agent-status/agent-pane-execution-host'
import { workspaceMarkerTabs, type MarkerTab } from './workspace-live-markers'
import { isExecutionHostForWorktree } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'

type WorkspaceTabIndex = {
  terminalPtyById: ReadonlyMap<string, string | null | undefined>
  stampedHostByTerminalId: ReadonlyMap<string, ExecutionHostId | undefined>
}

/** Index the workspace's tab arrays once so resolving T marker tabs is O(T), not O(T²). */
function indexWorkspaceTabs(state: AppState, workspaceId: string): WorkspaceTabIndex {
  const terminalPtyById = new Map<string, string | null | undefined>()
  for (const terminal of state.tabsByWorktree[workspaceId] ?? []) {
    if (!terminalPtyById.has(terminal.id)) {
      terminalPtyById.set(terminal.id, terminal.ptyId)
    }
  }
  const stampedHostByTerminalId = new Map<string, ExecutionHostId | undefined>()
  for (const tab of state.unifiedTabsByWorktree[workspaceId] ?? []) {
    // First match wins, matching the previous Array.find semantics.
    if (tab.contentType === 'terminal' && !stampedHostByTerminalId.has(tab.entityId)) {
      stampedHostByTerminalId.set(tab.entityId, tab.executionHostId)
    }
  }
  return { terminalPtyById, stampedHostByTerminalId }
}

const structuredPaneKeys = new Map<string, string>()

/** The pane whose status entry decides a marker tab's host: its active leaf, or its chat session. */
export function markerTabPaneKey(state: Pick<AppState, 'terminalLayoutsByTabId'>, tab: MarkerTab) {
  if (tab.sessionId === null) {
    return `${tab.id}:${state.terminalLayoutsByTabId[tab.id]?.activeLeafId ?? ''}`
  }
  // Why memoized: the structured key hashes the session id, and selectors call this per update.
  const cacheKey = `${tab.id}\n${tab.sessionId}`
  let paneKey = structuredPaneKeys.get(cacheKey)
  if (paneKey === undefined) {
    paneKey = structuredAgentSessionPaneKey(tab.id, tab.sessionId)
    structuredPaneKeys.set(cacheKey, paneKey)
    if (structuredPaneKeys.size > 4096) {
      structuredPaneKeys.delete(structuredPaneKeys.keys().next().value!)
    }
  }
  return paneKey
}

function markerTabHost(state: AppState, index: WorkspaceTabIndex, tab: MarkerTab) {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const paneKey = markerTabPaneKey(state, tab)
  const entry = state.agentStatusByPaneKey[paneKey]
  const ptyId =
    (layout?.activeLeafId ? layout.ptyIdsByLeafId?.[layout.activeLeafId] : undefined) ??
    index.terminalPtyById.get(tab.id) ??
    state.ptyIdsByTabId[tab.id]?.[0]
  if (tab.sessionId === null && !entry && !ptyId) {
    const stampedHost = index.stampedHostByTerminalId.get(tab.id)
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
  const tabs = workspaceMarkerTabs(state, workspaceId)
  if (executionHostId === undefined) {
    return new Set(tabs.map((tab) => tab.id))
  }
  const index = indexWorkspaceTabs(state, workspaceId)
  return new Set(
    tabs
      .filter((tab) =>
        isExecutionHostForWorktree(
          state,
          workspaceId,
          executionHostId,
          markerTabHost(state, index, tab)
        )
      )
      .map((tab) => tab.id)
  )
}
