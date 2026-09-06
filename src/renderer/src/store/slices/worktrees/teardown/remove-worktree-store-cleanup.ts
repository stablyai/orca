import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import { removeDeleteStatesForWorktreeIds } from './worktree-delete-state'
import { removeWorktreeVisitEntries } from '@/lib/worktree-visit-recency'
import { forgetAmbiguousOwnerWarnings } from '../listing/worktree-owner-settings'
import { omitRecordKey, omitRecordKeys } from './record-key-omission'

export function applyRemoveWorktreeSuccessState(
  set: WorktreeSliceSet,
  worktreeId: string,
  tabIds: Set<string>,
  executionHostId?: ExecutionHostId
): void {
  // Why outside `set`: it is module-scope, not store state. Dropping it also
  // re-arms the once-per-workspace warning if this id is ever added back.
  forgetAmbiguousOwnerWarnings([worktreeId])
  set((s) => {
    const next = { ...s.worktreesByRepo }
    for (const repoId of Object.keys(next)) {
      next[repoId] = next[repoId].filter((w) => w.id !== worktreeId)
    }
    const nextTabs = omitRecordKey(s.tabsByWorktree, worktreeId)
    const nextLayouts = omitRecordKeys(s.terminalLayoutsByTabId, tabIds)
    const nextPtyIdsByTabId = omitRecordKeys(s.ptyIdsByTabId, tabIds)
    const nextRuntimePaneTitlesByTabId = omitRecordKeys(s.runtimePaneTitlesByTabId, tabIds)
    const nextAutomaticAgentResumeClaimsByTabId = omitRecordKeys(
      s.automaticAgentResumeClaimsByTabId,
      tabIds
    )
    const nextNativeChatLaunchPromptByTabId = omitRecordKeys(
      s.nativeChatLaunchPromptByTabId,
      tabIds
    )
    const nextNativeChatLaunchDraftByTabId = omitRecordKeys(s.nativeChatLaunchDraftByTabId, tabIds)
    const nextUnverifiedPtyLossTabIds = omitRecordKeys(s.unverifiedPtyLossTabIds, tabIds)
    // Why: closeTab deletes these per-tab maps but removeWorktree missed them, leaking a split pane's expand flags.
    const nextExpandedPaneByTabId = omitRecordKeys(s.expandedPaneByTabId, tabIds)
    const nextCanExpandPaneByTabId = omitRecordKeys(s.canExpandPaneByTabId, tabIds)
    const nextDeleteState = removeDeleteStatesForWorktreeIds(
      s.deleteStateByWorktreeId,
      new Set([worktreeId])
    )
    const nextLineage = omitRecordKey(s.worktreeLineageById, worktreeId)
    const nextWorkspaceLineage = omitRecordKey(
      s.workspaceLineageByChildKey,
      worktreeWorkspaceKey(worktreeId)
    )
    // Clean up editor files belonging to this worktree
    const newOpenFiles = s.openFiles.filter((f) => f.worktreeId !== worktreeId)
    const nextBrowserTabsByWorktree = omitRecordKey(s.browserTabsByWorktree, worktreeId)
    const nextActiveFileIdByWorktree = omitRecordKey(s.activeFileIdByWorktree, worktreeId)
    const nextActiveBrowserTabIdByWorktree = omitRecordKey(
      s.activeBrowserTabIdByWorktree,
      worktreeId
    )
    // Why: closeBrowserTab records a Cmd+Shift+T undo snapshot, but a deleted worktree's tabs can't be restored; purge it.
    const nextRecentlyClosedBrowserTabsByWorktree = omitRecordKey(
      s.recentlyClosedBrowserTabsByWorktree,
      worktreeId
    )
    const nextActiveTabTypeByWorktree = omitRecordKey(s.activeTabTypeByWorktree, worktreeId)
    const nextActiveTabIdByWorktree = omitRecordKey(s.activeTabIdByWorktree, worktreeId)
    // Why: the tab strip persists visual order per worktree; drop the entry so stale tab IDs aren't retained.
    const nextTabBarOrderByWorktree = omitRecordKey(s.tabBarOrderByWorktree, worktreeId)
    const nextPendingReconnectTabByWorktree = omitRecordKey(
      s.pendingReconnectTabByWorktree,
      worktreeId
    )
    // Why: split-tab layout/group state is worktree-owned; leaving it makes a deleted worktree look restorable.
    const nextUnifiedTabsByWorktree = omitRecordKey(s.unifiedTabsByWorktree, worktreeId)
    const nextGroupsByWorktree = omitRecordKey(s.groupsByWorktree, worktreeId)
    const nextLayoutByWorktree = omitRecordKey(s.layoutByWorktree, worktreeId)
    const nextActiveGroupIdByWorktree = omitRecordKey(s.activeGroupIdByWorktree, worktreeId)
    // Why: git status/compare caches stop refreshing once the worktree is deleted; remove them so no stale badges/diffs linger.
    const nextGitStatusByWorktree = omitRecordKey(s.gitStatusByWorktree, worktreeId)
    const nextGitStatusHeadByWorktree = omitRecordKey(s.gitStatusHeadByWorktree, worktreeId)
    const nextGitBranchLineTotalByWorktree = omitRecordKey(
      s.gitBranchLineTotalByWorktree,
      worktreeId
    )
    const nextGitIgnoredPathsByWorktree = omitRecordKey(s.gitIgnoredPathsByWorktree, worktreeId)
    const nextGitConflictOperationByWorktree = omitRecordKey(
      s.gitConflictOperationByWorktree,
      worktreeId
    )
    const nextTrackedConflictPathsByWorktree = omitRecordKey(
      s.trackedConflictPathsByWorktree,
      worktreeId
    )
    const nextGitBranchChangesByWorktree = omitRecordKey(s.gitBranchChangesByWorktree, worktreeId)
    const nextGitBranchCompareSummaryByWorktree = omitRecordKey(
      s.gitBranchCompareSummaryByWorktree,
      worktreeId
    )
    const nextGitBranchCompareRequestKeyByWorktree = omitRecordKey(
      s.gitBranchCompareRequestKeyByWorktree,
      worktreeId
    )
    const nextGitBranchCompareRequestStatusHeadByWorktree = omitRecordKey(
      s.gitBranchCompareRequestStatusHeadByWorktree,
      worktreeId
    )
    // Why: clean up per-file editor state for the removed worktree so stale drafts/view modes don't accumulate.
    const removedFileIds = new Set<string>()
    for (const file of s.openFiles) {
      if (file.worktreeId !== worktreeId) {
        continue
      }
      removedFileIds.add(file.id)
      if (file.markdownPreviewSourceFileId) {
        removedFileIds.add(file.markdownPreviewSourceFileId)
      }
    }
    const nextEditorDrafts = omitRecordKeys(s.editorDrafts, removedFileIds)
    const nextMarkdownViewMode = omitRecordKeys(s.markdownViewMode, removedFileIds)
    const nextMarkdownRichModeSizeOverride = omitRecordKeys(
      s.markdownRichModeSizeOverride,
      removedFileIds
    )
    const nextEditorViewMode = omitRecordKeys(s.editorViewMode, removedFileIds)
    const nextMarkdownFrontmatterVisible = omitRecordKeys(
      s.markdownFrontmatterVisible,
      removedFileIds
    )
    // Why: editorCursorLine is keyed by fileId; clear it with the other per-file state so it doesn't leak.
    const nextEditorCursorLine = omitRecordKeys(s.editorCursorLine, removedFileIds)
    const nextExpandedDirs = omitRecordKey(s.expandedDirs, worktreeId)
    const nextShowDotfilesByWorktree = omitRecordKey(s.showDotfilesByWorktree, worktreeId)
    // Why: clear the huge-status marker so it doesn't linger after the worktree is gone.
    const nextGitStatusHugeByWorktree = omitRecordKey(s.gitStatusHugeByWorktree, worktreeId)
    const nextRightSidebarExplorerViewByWorktree = omitRecordKey(
      s.rightSidebarExplorerViewByWorktree,
      worktreeId
    )
    // If the active file belonged to the removed worktree, clear it
    const activeFileCleared = s.activeFileId
      ? s.openFiles.some((f) => f.id === s.activeFileId && f.worktreeId === worktreeId)
      : false
    const removedActiveWorktree = s.activeWorktreeId === worktreeId
    const nextEverActivatedWorktreeIds = s.everActivatedWorktreeIds.has(worktreeId)
      ? new Set([...s.everActivatedWorktreeIds].filter((id) => id !== worktreeId))
      : s.everActivatedWorktreeIds
    const nextLastVisitedAtByWorktreeId = removeWorktreeVisitEntries(
      s.lastVisitedAtByWorktreeId,
      new Set([worktreeId]),
      executionHostId
    )
    return {
      worktreesByRepo: next,
      worktreeLineageById: nextLineage,
      workspaceLineageByChildKey: nextWorkspaceLineage,
      tabsByWorktree: nextTabs,
      ptyIdsByTabId: nextPtyIdsByTabId,
      runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
      automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId,
      nativeChatLaunchPromptByTabId: nextNativeChatLaunchPromptByTabId,
      nativeChatLaunchDraftByTabId: nextNativeChatLaunchDraftByTabId,
      unverifiedPtyLossTabIds: nextUnverifiedPtyLossTabIds,
      terminalLayoutsByTabId: nextLayouts,
      expandedPaneByTabId: nextExpandedPaneByTabId,
      canExpandPaneByTabId: nextCanExpandPaneByTabId,
      deleteStateByWorktreeId: nextDeleteState,
      baseStatusByWorktreeId: omitRecordKey(s.baseStatusByWorktreeId, worktreeId),
      remoteBranchConflictByWorktreeId: omitRecordKey(
        s.remoteBranchConflictByWorktreeId,
        worktreeId
      ),
      fileSearchStateByWorktree: omitRecordKey(s.fileSearchStateByWorktree, worktreeId),
      // Why: these worktree-keyed maps are re-keyed on rename but were missed by removal, leaking one entry each.
      remoteStatusesByWorktree: omitRecordKey(s.remoteStatusesByWorktree, worktreeId),
      recentlyClosedEditorTabsByWorktree: omitRecordKey(
        s.recentlyClosedEditorTabsByWorktree,
        worktreeId
      ),
      recentlyClosedTerminalTabsByWorktree: omitRecordKey(
        s.recentlyClosedTerminalTabsByWorktree,
        worktreeId
      ),
      // Why: a deleted worktree's tabs can never be reopened; purge the kind list with the snapshot stacks above.
      recentlyClosedTabKindsByWorktree: omitRecordKey(
        s.recentlyClosedTabKindsByWorktree,
        worktreeId
      ),
      defaultTerminalTabsAppliedByWorktreeId: omitRecordKey(
        s.defaultTerminalTabsAppliedByWorktreeId,
        worktreeId
      ),
      activeWorktreeId: removedActiveWorktree ? null : s.activeWorktreeId,
      activeWorkspaceExecutionHostId: removedActiveWorktree
        ? null
        : s.activeWorkspaceExecutionHostId,
      activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
      openFiles: newOpenFiles,
      browserTabsByWorktree: nextBrowserTabsByWorktree,
      recentlyClosedBrowserTabsByWorktree: nextRecentlyClosedBrowserTabsByWorktree,
      activeFileIdByWorktree: nextActiveFileIdByWorktree,
      activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
      activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
      rightSidebarExplorerViewByWorktree: nextRightSidebarExplorerViewByWorktree,
      activeTabIdByWorktree: nextActiveTabIdByWorktree,
      tabBarOrderByWorktree: nextTabBarOrderByWorktree,
      pendingReconnectTabByWorktree: nextPendingReconnectTabByWorktree,
      unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
      groupsByWorktree: nextGroupsByWorktree,
      layoutByWorktree: nextLayoutByWorktree,
      activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
      editorDrafts: nextEditorDrafts,
      markdownViewMode: nextMarkdownViewMode,
      markdownRichModeSizeOverride: nextMarkdownRichModeSizeOverride,
      editorViewMode: nextEditorViewMode,
      markdownFrontmatterVisible: nextMarkdownFrontmatterVisible,
      editorCursorLine: nextEditorCursorLine,
      showDotfilesByWorktree: nextShowDotfilesByWorktree,
      expandedDirs: nextExpandedDirs,
      gitStatusHugeByWorktree: nextGitStatusHugeByWorktree,
      gitStatusByWorktree: nextGitStatusByWorktree,
      gitStatusHeadByWorktree: nextGitStatusHeadByWorktree,
      gitBranchLineTotalByWorktree: nextGitBranchLineTotalByWorktree,
      gitIgnoredPathsByWorktree: nextGitIgnoredPathsByWorktree,
      gitConflictOperationByWorktree: nextGitConflictOperationByWorktree,
      trackedConflictPathsByWorktree: nextTrackedConflictPathsByWorktree,
      gitBranchChangesByWorktree: nextGitBranchChangesByWorktree,
      gitBranchCompareSummaryByWorktree: nextGitBranchCompareSummaryByWorktree,
      gitBranchCompareRequestKeyByWorktree: nextGitBranchCompareRequestKeyByWorktree,
      gitBranchCompareRequestStatusHeadByWorktree: nextGitBranchCompareRequestStatusHeadByWorktree,
      activeFileId: activeFileCleared ? null : s.activeFileId,
      activeBrowserTabId: removedActiveWorktree ? null : s.activeBrowserTabId,
      activeTabType: removedActiveWorktree || activeFileCleared ? 'terminal' : s.activeTabType,
      everActivatedWorktreeIds: nextEverActivatedWorktreeIds,
      lastVisitedAtByWorktreeId: nextLastVisitedAtByWorktreeId,
      sortEpoch: s.sortEpoch + 1
    }
  })
}
