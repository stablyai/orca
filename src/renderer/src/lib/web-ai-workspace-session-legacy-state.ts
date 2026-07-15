import { WEB_AI_BROWSER_WORKSPACE_ID } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'

export function omitLegacyWebAiWorkspaceKey<T>(
  record: Record<string, T> | undefined
): Record<string, T> | undefined {
  if (!record || !(WEB_AI_BROWSER_WORKSPACE_ID in record)) {
    return record
  }
  const next = { ...record }
  delete next[WEB_AI_BROWSER_WORKSPACE_ID]
  return next
}

export function hasLegacyWebAiWorkspaceState(session: WorkspaceSessionState): boolean {
  const keyedRecords = [
    session.tabsByWorktree,
    session.openFilesByWorktree,
    session.activeFileIdByWorktree,
    session.browserTabsByWorktree,
    session.activeBrowserTabIdByWorktree,
    session.activeTabTypeByWorktree,
    session.activeTabIdByWorktree,
    session.unifiedTabs,
    session.tabGroups,
    session.tabGroupLayouts,
    session.activeGroupIdByWorktree,
    session.lastVisitedAtByWorktreeId,
    session.defaultTerminalTabsAppliedByWorktreeId
  ]
  return (
    session.activeWorktreeId === WEB_AI_BROWSER_WORKSPACE_ID ||
    session.activeWorkspaceKey === worktreeWorkspaceKey(WEB_AI_BROWSER_WORKSPACE_ID) ||
    keyedRecords.some((record) => Boolean(record && WEB_AI_BROWSER_WORKSPACE_ID in record)) ||
    (session.activeWorktreeIdsOnShutdown ?? []).includes(WEB_AI_BROWSER_WORKSPACE_ID) ||
    Object.values(session.browserPagesByWorkspace ?? {}).some((pages) =>
      pages.some((page) => page.worktreeId === WEB_AI_BROWSER_WORKSPACE_ID)
    ) ||
    Object.values(session.sleepingAgentSessionsByPaneKey ?? {}).some(
      (record) => record.worktreeId === WEB_AI_BROWSER_WORKSPACE_ID
    )
  )
}

export function removeLegacyWebAiTerminalState(
  session: WorkspaceSessionState
): Pick<
  WorkspaceSessionState,
  'tabsByWorktree' | 'terminalLayoutsByTabId' | 'remoteSessionIdsByTabId'
> {
  const legacyTerminalIds = new Set(
    (session.tabsByWorktree[WEB_AI_BROWSER_WORKSPACE_ID] ?? []).map((tab) => tab.id)
  )
  return {
    tabsByWorktree: omitLegacyWebAiWorkspaceKey(session.tabsByWorktree) ?? {},
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId).filter(
        ([tabId]) => !legacyTerminalIds.has(tabId)
      )
    ),
    remoteSessionIdsByTabId: session.remoteSessionIdsByTabId
      ? Object.fromEntries(
          Object.entries(session.remoteSessionIdsByTabId).filter(
            ([tabId]) => !legacyTerminalIds.has(tabId)
          )
        )
      : undefined
  }
}
