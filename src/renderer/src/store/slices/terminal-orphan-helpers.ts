import type { AppState } from '../types'

type OrphanTerminalDetectionState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'ptyIdsByTabId'
>

type OrphanTerminalCleanupState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'expandedPaneByTabId'
  | 'canExpandPaneByTabId'
  | 'terminalLayoutsByTabId'
  | 'pendingStartupByTabId'
  | 'pendingSetupSplitByTabId'
  | 'pendingIssueCommandSplitByTabId'
  | 'tabBarOrderByWorktree'
  | 'cacheTimerByKey'
  | 'activeTabIdByWorktree'
  | 'activeTabId'
>

export function getOrphanTerminalIds(
  state: OrphanTerminalDetectionState,
  worktreeId: string
): Set<string> {
  const runtimeTabs = state.tabsByWorktree[worktreeId] ?? []
  const unifiedTerminalEntityIds = new Set(
    (state.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'terminal')
      .map((tab) => tab.entityId)
  )

  return new Set(
    runtimeTabs
      .filter((tab) => {
        if (unifiedTerminalEntityIds.has(tab.id)) {
          return false
        }
        const livePtyIds = state.ptyIdsByTabId[tab.id] ?? []
        return livePtyIds.length === 0 && tab.ptyId == null
      })
      .map((tab) => tab.id)
  )
}

export function buildOrphanTerminalCleanupPatch(
  state: OrphanTerminalCleanupState,
  worktreeId: string,
  orphanTerminalIds: Set<string>
): Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'expandedPaneByTabId'
  | 'canExpandPaneByTabId'
  | 'terminalLayoutsByTabId'
  | 'pendingStartupByTabId'
  | 'pendingSetupSplitByTabId'
  | 'pendingIssueCommandSplitByTabId'
  | 'tabBarOrderByWorktree'
  | 'cacheTimerByKey'
  | 'activeTabIdByWorktree'
  | 'activeTabId'
> {
  const nextTabs = (state.tabsByWorktree[worktreeId] ?? []).filter(
    (tab) => !orphanTerminalIds.has(tab.id)
  )
  const nextPtyIdsByTabId = { ...state.ptyIdsByTabId }
  const nextRuntimePaneTitlesByTabId = { ...state.runtimePaneTitlesByTabId }
  const nextExpandedPaneByTabId = { ...state.expandedPaneByTabId }
  const nextCanExpandPaneByTabId = { ...state.canExpandPaneByTabId }
  const nextTerminalLayoutsByTabId = { ...state.terminalLayoutsByTabId }
  const nextPendingStartupByTabId = { ...state.pendingStartupByTabId }
  const nextPendingSetupSplitByTabId = { ...state.pendingSetupSplitByTabId }
  const nextPendingIssueCommandSplitByTabId = { ...state.pendingIssueCommandSplitByTabId }
  const nextTabBarOrderByWorktree = {
    ...state.tabBarOrderByWorktree,
    [worktreeId]: (state.tabBarOrderByWorktree[worktreeId] ?? []).filter(
      (tabId) => !orphanTerminalIds.has(tabId)
    )
  }
  const nextCacheTimerByKey = { ...state.cacheTimerByKey }

  // Why: orphan runtime terminals no longer have a backing unified tab or live
  // PTY, so every per-tab cache keyed off that runtime ID must disappear with
  // the tab. Centralizing the cleanup keeps orphan detection and teardown in
  // lockstep across both tab creation and reconciliation paths.
  for (const orphanTabId of orphanTerminalIds) {
    delete nextPtyIdsByTabId[orphanTabId]
    delete nextRuntimePaneTitlesByTabId[orphanTabId]
    delete nextExpandedPaneByTabId[orphanTabId]
    delete nextCanExpandPaneByTabId[orphanTabId]
    delete nextTerminalLayoutsByTabId[orphanTabId]
    delete nextPendingStartupByTabId[orphanTabId]
    delete nextPendingSetupSplitByTabId[orphanTabId]
    delete nextPendingIssueCommandSplitByTabId[orphanTabId]
    for (const key of Object.keys(nextCacheTimerByKey)) {
      if (key.startsWith(`${orphanTabId}:`)) {
        delete nextCacheTimerByKey[key]
      }
    }
  }

  const nextActiveTabIdByWorktree = {
    ...state.activeTabIdByWorktree,
    [worktreeId]: orphanTerminalIds.has(state.activeTabIdByWorktree[worktreeId] ?? '')
      ? (nextTabs[0]?.id ?? null)
      : state.activeTabIdByWorktree[worktreeId]
  }

  return {
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [worktreeId]: nextTabs
    },
    ptyIdsByTabId: nextPtyIdsByTabId,
    runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
    expandedPaneByTabId: nextExpandedPaneByTabId,
    canExpandPaneByTabId: nextCanExpandPaneByTabId,
    terminalLayoutsByTabId: nextTerminalLayoutsByTabId,
    pendingStartupByTabId: nextPendingStartupByTabId,
    pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
    pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
    tabBarOrderByWorktree: nextTabBarOrderByWorktree,
    cacheTimerByKey: nextCacheTimerByKey,
    activeTabIdByWorktree: nextActiveTabIdByWorktree,
    activeTabId:
      state.activeTabId && orphanTerminalIds.has(state.activeTabId) ? null : state.activeTabId
  }
}
