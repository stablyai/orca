import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { getAgentPaneExecutionHost } from '../agent-status/agent-pane-execution-host'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  completionPaneKeysByTabId,
  paneKeyTabId,
  workspaceMarkerTabs,
  type MarkerTab
} from './workspace-live-markers'
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

function markerTabHost(
  state: AppState,
  index: WorkspaceTabIndex,
  tab: MarkerTab,
  paneKey = markerTabPaneKey(state, tab)
) {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const leafId = parsePaneKey(paneKey)?.leafId
  const entry = state.agentStatusByPaneKey[paneKey]
  const ptyId =
    (leafId ? layout?.ptyIdsByLeafId?.[leafId] : undefined) ??
    index.terminalPtyById.get(tab.id) ??
    state.ptyIdsByTabId[tab.id]?.[0]
  if (
    tab.sessionId === null &&
    !ptyId &&
    !entry?.terminalHandle &&
    entry?.connectionId === undefined
  ) {
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

/** Pane markers follow their own execution host, including inactive panes in mixed-host tabs. */
export function workspaceMarkerPaneKeysForHost(
  state: AppState,
  workspaceId: string,
  executionHostId: ExecutionHostId | undefined,
  paneKeys: Iterable<string>
): Set<string> {
  const tabs = new Map(workspaceMarkerTabs(state, workspaceId).map((tab) => [tab.id, tab]))
  const index = indexWorkspaceTabs(state, workspaceId)
  return new Set(
    [...paneKeys].filter((key) => {
      const tabId = paneKeyTabId(key)
      const tab = tabId ? tabs.get(tabId) : undefined
      return (
        tab &&
        (executionHostId === undefined ||
          isExecutionHostForWorktree(
            state,
            workspaceId,
            executionHostId,
            markerTabHost(state, index, tab, key)
          ))
      )
    })
  )
}

export function workspaceHasLiveMarkerForHost(
  state: AppState,
  workspaceId: string,
  executionHostId?: ExecutionHostId | null
): boolean {
  const tabIds = workspaceMarkerTabIdsForHost(state, workspaceId, executionHostId ?? undefined)
  if ([...tabIds].some((id) => Boolean(state.unreadTerminalTabs[id]))) {
    return true
  }
  const completions = completionPaneKeysByTabId(state.unreadAgentCompletionPanes)
  const liveKeys = workspaceMarkerTabs(state, workspaceId).flatMap((tab) =>
    tab.sessionId === null
      ? [...(completions.get(tab.id) ?? [])]
      : state.unreadAgentCompletionPanes[structuredAgentSessionPaneKey(tab.id, tab.sessionId)]
        ? [structuredAgentSessionPaneKey(tab.id, tab.sessionId)]
        : []
  )
  return (
    workspaceMarkerPaneKeysForHost(state, workspaceId, executionHostId ?? undefined, liveKeys)
      .size > 0
  )
}
