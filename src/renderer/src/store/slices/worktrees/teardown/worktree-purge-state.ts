import type { AppState } from '../../../types'
import { forgetHugeRepoWarningDismissalsForWorktrees } from '@/lib/source-control-huge-repo-warning-dismissals'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { pruneHostedReviewLinkMutationGenerations } from '../metadata/hosted-review-link-mutation'
import { collectWorktreePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { createWorktreePurgeOmitters } from './worktree-purge-omitters'
import { removeDeleteStatesForWorktreeIds } from './worktree-delete-state'

export function buildWorktreePurgeState(s: AppState, worktreeIds: string[]): Partial<AppState> {
  const worktreeIdSet = new Set(worktreeIds)
  pruneHostedReviewLinkMutationGenerations(worktreeIdSet)
  // Why: every authoritative and explicit purge converges here, so a deleted path can't inherit stale UI state.
  forgetHugeRepoWarningDismissalsForWorktrees(worktreeIdSet)

  const doomed = collectWorktreePurgeDoomedIds(s, worktreeIdSet)
  const {
    omitByWorktree,
    omitWorkspaceLineageByWorktree,
    pruneRightSidebarTabByWorktree,
    omitByTabId,
    omitRetiredDirectSshLedgerByTabId,
    omitByPtyId,
    omitByPaneKeyTabPrefix,
    omitByBrowserWorkspaceId,
    omitByPageId,
    omitByFileId
  } = createWorktreePurgeOmitters(s, worktreeIdSet, doomed)

  const nextOpenFiles = s.openFiles.some((f) => worktreeIdSet.has(f.worktreeId))
    ? s.openFiles.filter((f) => !worktreeIdSet.has(f.worktreeId))
    : s.openFiles

  const removedActive = s.activeWorktreeId != null && worktreeIdSet.has(s.activeWorktreeId)
  const activeFileCleared = s.activeFileId != null && doomed.removedFileIds.has(s.activeFileId)
  const activeTabCleared = s.activeTabId != null && doomed.doomedTabIds.has(s.activeTabId)

  const nextEverActivatedWorktreeIds = (() => {
    let hit = false
    for (const id of worktreeIdSet) {
      if (s.everActivatedWorktreeIds.has(id)) {
        hit = true
        break
      }
    }
    if (!hit) {
      return s.everActivatedWorktreeIds
    }
    const next = new Set(s.everActivatedWorktreeIds)
    for (const id of worktreeIdSet) {
      next.delete(id)
    }
    return next
  })()
  const nextAgentStatusByPaneKey = omitByPaneKeyTabPrefix(s.agentStatusByPaneKey)

  return {
    // Worktree-scoped terminal/tab state
    worktreeLineageById: omitByWorktree(s.worktreeLineageById),
    workspaceLineageByChildKey: omitWorkspaceLineageByWorktree(s.workspaceLineageByChildKey),
    tabsByWorktree: omitByWorktree(s.tabsByWorktree),
    terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
    ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
    runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
    automaticAgentResumeClaimsByTabId: omitByTabId(s.automaticAgentResumeClaimsByTabId),
    nativeChatLaunchPromptByTabId: omitByTabId(s.nativeChatLaunchPromptByTabId),
    nativeChatLaunchDraftByTabId: omitByTabId(s.nativeChatLaunchDraftByTabId),
    // Why: bulk/hydration purge runs no terminal teardown, so it must drop the per-tab pane-expand flags itself.
    expandedPaneByTabId: omitByTabId(s.expandedPaneByTabId),
    canExpandPaneByTabId: omitByTabId(s.canExpandPaneByTabId),
    // Why: these per-tab/per-pty terminal+agent maps evict on the single removeWorktree teardown path; the bulk reconcile / remove-project / hydration-stale paths run no teardown, so without these each strands an entry per tab/pane of externally-removed worktrees.
    lastKnownRelayPtyIdByTabId: omitByTabId(s.lastKnownRelayPtyIdByTabId),
    // Why: liveness-authoritative reconnect maps (orphan sweep reads them); drop purged tabs' entries here too so a re-materialized id can't inherit phantom liveness.
    pendingReconnectPtyIdByTabId: omitByTabId(s.pendingReconnectPtyIdByTabId),
    deferredSshSessionIdsByTabId: omitByTabId(s.deferredSshSessionIdsByTabId),
    pendingInitialCwdByTabId: omitByTabId(s.pendingInitialCwdByTabId),
    pendingIssueCommandSplitByTabId: omitByTabId(s.pendingIssueCommandSplitByTabId),
    pendingSetupSplitByTabId: omitByTabId(s.pendingSetupSplitByTabId),
    pendingStartupByTabId: omitByTabId(s.pendingStartupByTabId),
    directSshPaneRetryByTabId: omitRetiredDirectSshLedgerByTabId(s.directSshPaneRetryByTabId),
    directSshLivePtyBindingByTabId: omitRetiredDirectSshLedgerByTabId(
      s.directSshLivePtyBindingByTabId
    ),
    directSshPaneRetryHistoryByTabId: omitRetiredDirectSshLedgerByTabId(
      s.directSshPaneRetryHistoryByTabId
    ),
    codexRestartNoticeByPtyId: omitByPtyId(s.codexRestartNoticeByPtyId),
    migrationUnsupportedByPtyId: omitByPtyId(s.migrationUnsupportedByPtyId),
    suppressedPtyExitIds: omitByPtyId(s.suppressedPtyExitIds),
    pendingCodexPaneRestartIds: omitByPtyId(s.pendingCodexPaneRestartIds),
    // Why: these agent-status/unread/input maps clear only on the single removeWorktree teardown path; the bulk reconcile / remove-project / hydration-stale paths run no teardown, so without this they orphan an entry per agent pane (plus a phantom unread badge).
    // retainedAgentsByPaneKey and runtimeAgentOrchestrationByPaneKey are omitted here — both self-heal (pruneRetainedAgents on worktreesByRepo change; runtime map replaced wholesale each sync).
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    ...(nextAgentStatusByPaneKey !== s.agentStatusByPaneKey
      ? { agentStatusEpoch: s.agentStatusEpoch + 1 }
      : {}),
    agentLaunchConfigByPaneKey: omitByPaneKeyTabPrefix(s.agentLaunchConfigByPaneKey),
    acknowledgedAgentsByPaneKey: omitByPaneKeyTabPrefix(s.acknowledgedAgentsByPaneKey),
    paneForegroundAgentByPaneKey: omitByPaneKeyTabPrefix(s.paneForegroundAgentByPaneKey),
    sleepingAgentSessionsByPaneKey: omitByPaneKeyTabPrefix(s.sleepingAgentSessionsByPaneKey),
    unreadTerminalTabs: omitByTabId(s.unreadTerminalTabs),
    unreadTerminalPanes: omitByPaneKeyTabPrefix(s.unreadTerminalPanes),
    unreadAgentCompletionPanes: omitByPaneKeyTabPrefix(s.unreadAgentCompletionPanes),
    lastTerminalInputAtByPaneKey: omitByPaneKeyTabPrefix(s.lastTerminalInputAtByPaneKey),
    // Delete state
    deleteStateByWorktreeId: removeDeleteStatesForWorktreeIds(
      s.deleteStateByWorktreeId,
      worktreeIdSet
    ),
    baseStatusByWorktreeId: omitByWorktree(s.baseStatusByWorktreeId),
    remoteBranchConflictByWorktreeId: omitByWorktree(s.remoteBranchConflictByWorktreeId),
    // File search
    fileSearchStateByWorktree: omitByWorktree(s.fileSearchStateByWorktree),
    // Browser state
    browserTabsByWorktree: omitByWorktree(s.browserTabsByWorktree),
    browserPagesByWorkspace: omitByBrowserWorkspaceId(s.browserPagesByWorkspace),
    recentlyClosedBrowserTabsByWorktree: omitByWorktree(s.recentlyClosedBrowserTabsByWorktree),
    activeBrowserTabIdByWorktree: omitByWorktree(s.activeBrowserTabIdByWorktree),
    // Why: keyed by page/workspace id, only cleaned by closeBrowserTab on the single-removal path; the bulk reconcile missed them, orphaning an entry per page of externally-removed worktrees.
    browserAnnotationsByPageId: omitByPageId(s.browserAnnotationsByPageId),
    remoteBrowserPageHandlesByPageId: omitByPageId(s.remoteBrowserPageHandlesByPageId),
    pendingAddressBarFocusByPageId: omitByPageId(s.pendingAddressBarFocusByPageId),
    // createBrowserTab writes both the workspace id and the page id into this map.
    pendingAddressBarFocusByTabId: omitByPageId(
      omitByBrowserWorkspaceId(s.pendingAddressBarFocusByTabId)
    ),
    recentlyClosedBrowserPagesByWorkspace: omitByBrowserWorkspaceId(
      s.recentlyClosedBrowserPagesByWorkspace
    ),
    // Editor state
    activeFileIdByWorktree: omitByWorktree(s.activeFileIdByWorktree),
    activeTabTypeByWorktree: omitByWorktree(s.activeTabTypeByWorktree),
    activeTabIdByWorktree: omitByWorktree(s.activeTabIdByWorktree),
    tabBarOrderByWorktree: omitByWorktree(s.tabBarOrderByWorktree),
    pendingReconnectTabByWorktree: omitByWorktree(s.pendingReconnectTabByWorktree),
    rightSidebarTabByWorktree: pruneRightSidebarTabByWorktree(),
    rightSidebarExplorerViewByWorktree: omitByWorktree(s.rightSidebarExplorerViewByWorktree ?? {}),
    // Split-tab / unified tab state
    unifiedTabsByWorktree: omitByWorktree(s.unifiedTabsByWorktree),
    groupsByWorktree: omitByWorktree(s.groupsByWorktree),
    layoutByWorktree: omitByWorktree(s.layoutByWorktree),
    activeGroupIdByWorktree: omitByWorktree(s.activeGroupIdByWorktree),
    // Git status caches
    gitStatusByWorktree: omitByWorktree(s.gitStatusByWorktree),
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal paths (upstream-status entry).
    remoteStatusesByWorktree: omitByWorktree(s.remoteStatusesByWorktree),
    gitStatusHeadByWorktree: omitByWorktree(s.gitStatusHeadByWorktree),
    gitBranchLineTotalByWorktree: omitByWorktree(s.gitBranchLineTotalByWorktree),
    gitIgnoredPathsByWorktree: omitByWorktree(s.gitIgnoredPathsByWorktree),
    gitConflictOperationByWorktree: omitByWorktree(s.gitConflictOperationByWorktree),
    trackedConflictPathsByWorktree: omitByWorktree(s.trackedConflictPathsByWorktree),
    gitBranchChangesByWorktree: omitByWorktree(s.gitBranchChangesByWorktree),
    gitBranchCompareSummaryByWorktree: omitByWorktree(s.gitBranchCompareSummaryByWorktree),
    gitBranchCompareRequestKeyByWorktree: omitByWorktree(s.gitBranchCompareRequestKeyByWorktree),
    gitBranchCompareRequestStatusHeadByWorktree: omitByWorktree(
      s.gitBranchCompareRequestStatusHeadByWorktree
    ),
    // Why: keyed by worktreeId; without this it leaks a huge-status marker per removed worktree.
    gitStatusHugeByWorktree: omitByWorktree(s.gitStatusHugeByWorktree),
    showDotfilesByWorktree: omitByWorktree(s.showDotfilesByWorktree),
    expandedDirs: omitByWorktree(s.expandedDirs),
    // Per-file editor state for removed files
    editorDrafts: omitByFileId(s.editorDrafts),
    markdownViewMode: omitByFileId(s.markdownViewMode),
    markdownFrontmatterVisible: omitByFileId(s.markdownFrontmatterVisible),
    // Why: keyed by fileId; the bulk reconcile path previously kept these, leaking a cursor-line / view-mode entry per removed file.
    editorCursorLine: omitByFileId(s.editorCursorLine),
    editorViewMode: omitByFileId(s.editorViewMode),
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal paths (editor-undo / Cmd+Shift+T snapshots).
    recentlyClosedEditorTabsByWorktree: omitByWorktree(s.recentlyClosedEditorTabsByWorktree),
    recentlyClosedTerminalTabsByWorktree: omitByWorktree(s.recentlyClosedTerminalTabsByWorktree),
    recentlyClosedTabKindsByWorktree: omitByWorktree(s.recentlyClosedTabKindsByWorktree),
    // Top-level actives
    openFiles: nextOpenFiles,
    everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
    lastVisitedAtByWorktreeId: omitByWorktree(s.lastVisitedAtByWorktreeId),
    // Why: keyed by worktreeId; re-keyed on rename but missed by both removal paths (write-once default-terminal guard).
    defaultTerminalTabsAppliedByWorktreeId: omitByWorktree(
      s.defaultTerminalTabsAppliedByWorktreeId
    ),
    activeWorktreeId: removedActive ? null : s.activeWorktreeId,
    activeWorkspaceExecutionHostId: removedActive ? null : s.activeWorkspaceExecutionHostId,
    activeWorkspaceKey: (() => {
      if (s.activeWorkspaceKey && worktreeIdSet.has(s.activeWorkspaceKey)) {
        return null
      }
      const activeScope = s.activeWorkspaceKey ? parseWorkspaceKey(s.activeWorkspaceKey) : null
      return activeScope?.type === 'worktree' && worktreeIdSet.has(activeScope.worktreeId)
        ? null
        : s.activeWorkspaceKey
    })(),
    activeFileId: activeFileCleared ? null : s.activeFileId,
    activeBrowserTabId: removedActive ? null : s.activeBrowserTabId,
    activeTabId: activeTabCleared ? null : s.activeTabId,
    activeTabType: removedActive || activeFileCleared ? 'terminal' : s.activeTabType
  }
}
