import type { AppState } from '../types'

type TerminalTabReconnectState = Pick<
  AppState,
  | 'ptyIdsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'deferredSshSessionIdsByTabId'
  | 'pendingReconnectPtyIdByTabId'
  | 'unverifiedPtyLossTabIds'
>

type OrphanTerminalDetectionState = Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'> &
  TerminalTabReconnectState

/** Live/reconnect maps prove PTY ownership, matching retirement (#9911); persisted leaf bindings may outlive removed SSH sessions and must not pin dead tabs. */
export function terminalTabHasReconnectablePty(
  state: TerminalTabReconnectState,
  tabId: string,
  rowPtyId: string | null | undefined
): boolean {
  return Boolean(
    (state.ptyIdsByTabId[tabId]?.length ?? 0) > 0 ||
    rowPtyId ||
    state.lastKnownRelayPtyIdByTabId[tabId] ||
    state.deferredSshSessionIdsByTabId[tabId] ||
    state.pendingReconnectPtyIdByTabId[tabId]
  )
}

type OrphanTerminalCleanupState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'expandedPaneByTabId'
  | 'canExpandPaneByTabId'
  | 'terminalLayoutsByTabId'
  | 'pendingStartupByTabId'
  | 'pendingInitialCwdByTabId'
  | 'pendingIssueCommandSplitByTabId'
  | 'automaticAgentResumeClaimsByTabId'
  | 'nativeChatLaunchPromptByTabId'
  | 'nativeChatLaunchDraftByTabId'
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
        // Host loss can emit synthetic exit; missing PTY alone cannot prove user closure. Keep until replacement or explicit close.
        if (state.unverifiedPtyLossTabIds[tab.id]) {
          return false
        }
        return !terminalTabHasReconnectablePty(state, tab.id, tab.ptyId)
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
  | 'pendingInitialCwdByTabId'
  | 'pendingIssueCommandSplitByTabId'
  | 'automaticAgentResumeClaimsByTabId'
  | 'nativeChatLaunchPromptByTabId'
  | 'nativeChatLaunchDraftByTabId'
  | 'tabBarOrderByWorktree'
  | 'cacheTimerByKey'
  | 'activeTabIdByWorktree'
  | 'activeTabId'
> {
  if (orphanTerminalIds.size === 0) {
    return {
      tabsByWorktree: state.tabsByWorktree,
      ptyIdsByTabId: state.ptyIdsByTabId,
      runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
      expandedPaneByTabId: state.expandedPaneByTabId,
      canExpandPaneByTabId: state.canExpandPaneByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      pendingStartupByTabId: state.pendingStartupByTabId,
      pendingInitialCwdByTabId: state.pendingInitialCwdByTabId,
      pendingIssueCommandSplitByTabId: state.pendingIssueCommandSplitByTabId,
      automaticAgentResumeClaimsByTabId: state.automaticAgentResumeClaimsByTabId,
      nativeChatLaunchPromptByTabId: state.nativeChatLaunchPromptByTabId,
      nativeChatLaunchDraftByTabId: state.nativeChatLaunchDraftByTabId,
      tabBarOrderByWorktree: state.tabBarOrderByWorktree,
      cacheTimerByKey: state.cacheTimerByKey,
      activeTabIdByWorktree: state.activeTabIdByWorktree,
      activeTabId: state.activeTabId
    }
  }

  const nextTabs = (state.tabsByWorktree[worktreeId] ?? []).filter(
    (tab) => !orphanTerminalIds.has(tab.id)
  )
  const nextPtyIdsByTabId = { ...state.ptyIdsByTabId }
  const nextRuntimePaneTitlesByTabId = { ...state.runtimePaneTitlesByTabId }
  const nextExpandedPaneByTabId = { ...state.expandedPaneByTabId }
  const nextCanExpandPaneByTabId = { ...state.canExpandPaneByTabId }
  const nextTerminalLayoutsByTabId = { ...state.terminalLayoutsByTabId }
  const nextPendingStartupByTabId = { ...state.pendingStartupByTabId }
  const nextPendingInitialCwdByTabId = { ...state.pendingInitialCwdByTabId }
  const nextPendingIssueCommandSplitByTabId = { ...state.pendingIssueCommandSplitByTabId }
  const nextAutomaticAgentResumeClaimsByTabId = {
    ...state.automaticAgentResumeClaimsByTabId
  }
  const nextNativeChatLaunchPromptByTabId = { ...state.nativeChatLaunchPromptByTabId }
  const nextNativeChatLaunchDraftByTabId = { ...state.nativeChatLaunchDraftByTabId }
  const nextTabBarOrderByWorktree = {
    ...state.tabBarOrderByWorktree,
    [worktreeId]: (state.tabBarOrderByWorktree[worktreeId] ?? []).filter(
      (tabId) => !orphanTerminalIds.has(tabId)
    )
  }
  const nextCacheTimerByKey = { ...state.cacheTimerByKey }

  // Share per-tab cache teardown across creation/reconciliation so orphan detection and cleanup cannot diverge.
  for (const orphanTabId of orphanTerminalIds) {
    delete nextPtyIdsByTabId[orphanTabId]
    delete nextRuntimePaneTitlesByTabId[orphanTabId]
    delete nextExpandedPaneByTabId[orphanTabId]
    delete nextCanExpandPaneByTabId[orphanTabId]
    delete nextTerminalLayoutsByTabId[orphanTabId]
    delete nextPendingStartupByTabId[orphanTabId]
    delete nextPendingInitialCwdByTabId[orphanTabId]
    delete nextPendingIssueCommandSplitByTabId[orphanTabId]
    delete nextAutomaticAgentResumeClaimsByTabId[orphanTabId]
    delete nextNativeChatLaunchPromptByTabId[orphanTabId]
    delete nextNativeChatLaunchDraftByTabId[orphanTabId]
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
    pendingInitialCwdByTabId: nextPendingInitialCwdByTabId,
    pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
    automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId,
    nativeChatLaunchPromptByTabId: nextNativeChatLaunchPromptByTabId,
    nativeChatLaunchDraftByTabId: nextNativeChatLaunchDraftByTabId,
    tabBarOrderByWorktree: nextTabBarOrderByWorktree,
    cacheTimerByKey: nextCacheTimerByKey,
    activeTabIdByWorktree: nextActiveTabIdByWorktree,
    activeTabId:
      state.activeTabId && orphanTerminalIds.has(state.activeTabId) ? null : state.activeTabId
  }
}
