import type { AppState } from '../types'

type TerminalTabReconnectState = Pick<
  AppState,
  | 'ptyIdsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'deferredSshSessionIdsByTabId'
  | 'pendingReconnectPtyIdByTabId'
>

type OrphanTerminalDetectionState = Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'> &
  TerminalTabReconnectState

/**
 * Whether a tab is currently attached to, or actively reconnecting to, a live
 * PTY. This deliberately checks only the live-attachment and reconnect maps —
 * NOT terminalLayoutsByTabId leaf bindings, which are a persisted layout that
 * can outlive its session (e.g. after an SSH target is removed) and must not
 * keep a dead tab pinned in the orphan sweep. The reconnect maps are the ones
 * retirement planning also honors as live ownership, so a tab it would tear
 * down on close is never swept as a dead orphan first (#9911).
 */
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
  | 'pendingSetupSplitByTabId'
  | 'pendingIssueCommandSplitByTabId'
  | 'automaticAgentResumeClaimsByTabId'
  | 'nativeChatLaunchPromptByTabId'
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
        // Why: a tab is orphaned only when it owns NO live/reconnecting PTY; a
        // tab whose session survives in a reconnect map (SSH relay / daemon
        // reattach) is alive and must not be swept before reconnect rebinds it
        // (#9911).
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
  | 'pendingSetupSplitByTabId'
  | 'pendingIssueCommandSplitByTabId'
  | 'automaticAgentResumeClaimsByTabId'
  | 'nativeChatLaunchPromptByTabId'
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
      pendingSetupSplitByTabId: state.pendingSetupSplitByTabId,
      pendingIssueCommandSplitByTabId: state.pendingIssueCommandSplitByTabId,
      automaticAgentResumeClaimsByTabId: state.automaticAgentResumeClaimsByTabId,
      nativeChatLaunchPromptByTabId: state.nativeChatLaunchPromptByTabId,
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
  const nextPendingSetupSplitByTabId = { ...state.pendingSetupSplitByTabId }
  const nextPendingIssueCommandSplitByTabId = { ...state.pendingIssueCommandSplitByTabId }
  const nextAutomaticAgentResumeClaimsByTabId = {
    ...state.automaticAgentResumeClaimsByTabId
  }
  const nextNativeChatLaunchPromptByTabId = { ...state.nativeChatLaunchPromptByTabId }
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
    delete nextPendingInitialCwdByTabId[orphanTabId]
    delete nextPendingSetupSplitByTabId[orphanTabId]
    delete nextPendingIssueCommandSplitByTabId[orphanTabId]
    delete nextAutomaticAgentResumeClaimsByTabId[orphanTabId]
    delete nextNativeChatLaunchPromptByTabId[orphanTabId]
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
    pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
    pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
    automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId,
    nativeChatLaunchPromptByTabId: nextNativeChatLaunchPromptByTabId,
    tabBarOrderByWorktree: nextTabBarOrderByWorktree,
    cacheTimerByKey: nextCacheTimerByKey,
    activeTabIdByWorktree: nextActiveTabIdByWorktree,
    activeTabId:
      state.activeTabId && orphanTerminalIds.has(state.activeTabId) ? null : state.activeTabId
  }
}
