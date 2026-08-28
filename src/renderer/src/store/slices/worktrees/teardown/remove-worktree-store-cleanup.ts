import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import { removeDeleteStatesForWorktreeIds } from './worktree-delete-state'
import { removeWorktreeVisitEntries } from '@/lib/worktree-visit-recency'

export function applyRemoveWorktreeSuccessState(
  set: WorktreeSliceSet,
  worktreeId: string,
  tabIds: Set<string>,
  executionHostId?: ExecutionHostId
): void {
  set((s) => {
    const next = { ...s.worktreesByRepo }
    for (const repoId of Object.keys(next)) {
      next[repoId] = next[repoId].filter((w) => w.id !== worktreeId)
    }
    const nextTabs = { ...s.tabsByWorktree }
    delete nextTabs[worktreeId]
    const nextLayouts = { ...s.terminalLayoutsByTabId }
    const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
    const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
    const nextAutomaticAgentResumeClaimsByTabId = {
      ...s.automaticAgentResumeClaimsByTabId
    }
    const nextNativeChatLaunchPromptByTabId = { ...s.nativeChatLaunchPromptByTabId }
    const nextNativeChatLaunchDraftByTabId = { ...s.nativeChatLaunchDraftByTabId }
    // Why: closeTab deletes these per-tab maps but removeWorktree missed them, leaking a split pane's expand flags.
    const nextExpandedPaneByTabId = { ...s.expandedPaneByTabId }
    const nextCanExpandPaneByTabId = { ...s.canExpandPaneByTabId }
    for (const tabId of tabIds) {
      delete nextLayouts[tabId]
      delete nextPtyIdsByTabId[tabId]
      delete nextRuntimePaneTitlesByTabId[tabId]
      delete nextAutomaticAgentResumeClaimsByTabId[tabId]
      delete nextNativeChatLaunchPromptByTabId[tabId]
      delete nextNativeChatLaunchDraftByTabId[tabId]
      delete nextExpandedPaneByTabId[tabId]
      delete nextCanExpandPaneByTabId[tabId]
    }
    const nextDeleteState = removeDeleteStatesForWorktreeIds(
      s.deleteStateByWorktreeId,
      new Set([worktreeId])
    )
    const nextLineage = { ...s.worktreeLineageById }
    delete nextLineage[worktreeId]
    const nextWorkspaceLineage = { ...s.workspaceLineageByChildKey }
    delete nextWorkspaceLineage[worktreeWorkspaceKey(worktreeId)]
    // Clean up editor files belonging to this worktree
    const newOpenFiles = s.openFiles.filter((f) => f.worktreeId !== worktreeId)
    const nextBrowserTabsByWorktree = { ...s.browserTabsByWorktree }
    delete nextBrowserTabsByWorktree[worktreeId]
    const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
    delete nextActiveFileIdByWorktree[worktreeId]
    const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
    delete nextActiveBrowserTabIdByWorktree[worktreeId]
    // Why: closeBrowserTab records a Cmd+Shift+T undo snapshot, but a deleted worktree's tabs can't be restored; purge it.
    const nextRecentlyClosedBrowserTabsByWorktree = {
      ...s.recentlyClosedBrowserTabsByWorktree
    }
    delete nextRecentlyClosedBrowserTabsByWorktree[worktreeId]
    const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
    delete nextActiveTabTypeByWorktree[worktreeId]
    const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
    delete nextActiveTabIdByWorktree[worktreeId]
    const nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
    // Why: the tab strip persists visual order per worktree; drop the entry so stale tab IDs aren't retained.
    delete nextTabBarOrderByWorktree[worktreeId]
    const nextPendingReconnectTabByWorktree = { ...s.pendingReconnectTabByWorktree }
    delete nextPendingReconnectTabByWorktree[worktreeId]
    // Why: split-tab layout/group state is worktree-owned; leaving it makes a deleted worktree look restorable.
    const nextUnifiedTabsByWorktree = { ...s.unifiedTabsByWorktree }
    delete nextUnifiedTabsByWorktree[worktreeId]
    const nextGroupsByWorktree = { ...s.groupsByWorktree }
    delete nextGroupsByWorktree[worktreeId]
    const nextLayoutByWorktree = { ...s.layoutByWorktree }
    delete nextLayoutByWorktree[worktreeId]
    const nextActiveGroupIdByWorktree = { ...s.activeGroupIdByWorktree }
    delete nextActiveGroupIdByWorktree[worktreeId]
    // Why: git status/compare caches stop refreshing once the worktree is deleted; remove them so no stale badges/diffs linger.
    const nextGitStatusByWorktree = { ...s.gitStatusByWorktree }
    delete nextGitStatusByWorktree[worktreeId]
    const nextGitStatusHeadByWorktree = { ...s.gitStatusHeadByWorktree }
    delete nextGitStatusHeadByWorktree[worktreeId]
    const nextGitBranchLineTotalByWorktree = { ...s.gitBranchLineTotalByWorktree }
    delete nextGitBranchLineTotalByWorktree[worktreeId]
    const nextGitIgnoredPathsByWorktree = { ...s.gitIgnoredPathsByWorktree }
    delete nextGitIgnoredPathsByWorktree[worktreeId]
    const nextGitConflictOperationByWorktree = { ...s.gitConflictOperationByWorktree }
    delete nextGitConflictOperationByWorktree[worktreeId]
    const nextTrackedConflictPathsByWorktree = { ...s.trackedConflictPathsByWorktree }
    delete nextTrackedConflictPathsByWorktree[worktreeId]
    const nextGitBranchChangesByWorktree = { ...s.gitBranchChangesByWorktree }
    delete nextGitBranchChangesByWorktree[worktreeId]
    const nextGitBranchCompareSummaryByWorktree = { ...s.gitBranchCompareSummaryByWorktree }
    delete nextGitBranchCompareSummaryByWorktree[worktreeId]
    const nextGitBranchCompareRequestKeyByWorktree = {
      ...s.gitBranchCompareRequestKeyByWorktree
    }
    delete nextGitBranchCompareRequestKeyByWorktree[worktreeId]
    const nextGitBranchCompareRequestStatusHeadByWorktree = {
      ...s.gitBranchCompareRequestStatusHeadByWorktree
    }
    delete nextGitBranchCompareRequestStatusHeadByWorktree[worktreeId]
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
    const nextEditorDrafts = removedFileIds.size > 0 ? { ...s.editorDrafts } : s.editorDrafts
    const nextMarkdownViewMode =
      removedFileIds.size > 0 ? { ...s.markdownViewMode } : s.markdownViewMode
    const nextMarkdownRichModeSizeOverride =
      removedFileIds.size > 0
        ? { ...s.markdownRichModeSizeOverride }
        : s.markdownRichModeSizeOverride
    const nextEditorViewMode = removedFileIds.size > 0 ? { ...s.editorViewMode } : s.editorViewMode
    const nextMarkdownFrontmatterVisible =
      removedFileIds.size > 0 ? { ...s.markdownFrontmatterVisible } : s.markdownFrontmatterVisible
    // Why: editorCursorLine is keyed by fileId; clear it with the other per-file state so it doesn't leak.
    const nextEditorCursorLine =
      removedFileIds.size > 0 ? { ...s.editorCursorLine } : s.editorCursorLine
    if (removedFileIds.size > 0) {
      for (const fileId of removedFileIds) {
        delete nextEditorDrafts[fileId]
        delete nextMarkdownViewMode[fileId]
        delete nextMarkdownRichModeSizeOverride[fileId]
        delete nextEditorViewMode[fileId]
        delete nextMarkdownFrontmatterVisible[fileId]
        delete nextEditorCursorLine[fileId]
      }
    }
    const nextExpandedDirs = { ...s.expandedDirs }
    delete nextExpandedDirs[worktreeId]
    const nextShowDotfilesByWorktree = { ...s.showDotfilesByWorktree }
    delete nextShowDotfilesByWorktree[worktreeId]
    // Why: clear the huge-status marker so it doesn't linger after the worktree is gone.
    const nextGitStatusHugeByWorktree = { ...s.gitStatusHugeByWorktree }
    delete nextGitStatusHugeByWorktree[worktreeId]
    const nextRightSidebarExplorerViewByWorktree = {
      ...s.rightSidebarExplorerViewByWorktree
    }
    delete nextRightSidebarExplorerViewByWorktree[worktreeId]
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
      terminalLayoutsByTabId: nextLayouts,
      expandedPaneByTabId: nextExpandedPaneByTabId,
      canExpandPaneByTabId: nextCanExpandPaneByTabId,
      deleteStateByWorktreeId: nextDeleteState,
      baseStatusByWorktreeId: (() => {
        const nextStatus = { ...s.baseStatusByWorktreeId }
        delete nextStatus[worktreeId]
        return nextStatus
      })(),
      remoteBranchConflictByWorktreeId: (() => {
        const nextConflict = { ...s.remoteBranchConflictByWorktreeId }
        delete nextConflict[worktreeId]
        return nextConflict
      })(),
      fileSearchStateByWorktree: (() => {
        const nextSearch = { ...s.fileSearchStateByWorktree }
        // Why: file search state is worktree-scoped; clear it so another worktree can't inherit stale matches.
        delete nextSearch[worktreeId]
        return nextSearch
      })(),
      // Why: these worktree-keyed maps are re-keyed on rename but were missed by removal, leaking one entry each.
      remoteStatusesByWorktree: (() => {
        const next = { ...s.remoteStatusesByWorktree }
        delete next[worktreeId]
        return next
      })(),
      recentlyClosedEditorTabsByWorktree: (() => {
        const next = { ...s.recentlyClosedEditorTabsByWorktree }
        delete next[worktreeId]
        return next
      })(),
      recentlyClosedTerminalTabsByWorktree: (() => {
        const next = { ...s.recentlyClosedTerminalTabsByWorktree }
        delete next[worktreeId]
        return next
      })(),
      // Why: a deleted worktree's tabs can never be reopened; purge the kind list with the snapshot stacks above.
      recentlyClosedTabKindsByWorktree: (() => {
        const next = { ...s.recentlyClosedTabKindsByWorktree }
        delete next[worktreeId]
        return next
      })(),
      defaultTerminalTabsAppliedByWorktreeId: (() => {
        const next = { ...s.defaultTerminalTabsAppliedByWorktreeId }
        delete next[worktreeId]
        return next
      })(),
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
