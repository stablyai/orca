import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import { removeDeleteStatesForWorktreeIds } from './worktree-delete-state'
import { removeWorktreeVisitEntries } from '@/lib/worktree-visit-recency'
import { forgetAmbiguousOwnerWarnings } from '../listing/worktree-owner-settings'
import { omitRecordKeys } from './record-key-omission'

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
    const worktreeIds = [worktreeId]
    const omitByWorktree = <T>(m: Record<string, T> | undefined) => omitRecordKeys(m, worktreeIds)
    const omitByTabId = <T>(m: Record<string, T> | undefined) => omitRecordKeys(m, tabIds)
    const nextWorktreesByRepo = { ...s.worktreesByRepo }
    for (const repoId of Object.keys(nextWorktreesByRepo)) {
      nextWorktreesByRepo[repoId] = nextWorktreesByRepo[repoId].filter((w) => w.id !== worktreeId)
    }
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
    const omitByFileId = <T>(m: Record<string, T> | undefined) => omitRecordKeys(m, removedFileIds)
    // Why guarded: a removed worktree usually has no open file, and an unconditional
    // filter would hand openFiles a new identity anyway — the sibling purge path
    // already does this.
    const nextOpenFiles = s.openFiles.some((f) => f.worktreeId === worktreeId)
      ? s.openFiles.filter((f) => f.worktreeId !== worktreeId)
      : s.openFiles
    // If the active file belonged to the removed worktree, clear it
    const activeFileCleared = s.activeFileId
      ? s.openFiles.some((f) => f.id === s.activeFileId && f.worktreeId === worktreeId)
      : false
    const removedActiveWorktree = s.activeWorktreeId === worktreeId
    return {
      worktreesByRepo: nextWorktreesByRepo,
      worktreeLineageById: omitByWorktree(s.worktreeLineageById),
      workspaceLineageByChildKey: omitRecordKeys(s.workspaceLineageByChildKey, [
        worktreeWorkspaceKey(worktreeId)
      ]),
      tabsByWorktree: omitByWorktree(s.tabsByWorktree),
      ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
      runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
      automaticAgentResumeClaimsByTabId: omitByTabId(s.automaticAgentResumeClaimsByTabId),
      nativeChatLaunchPromptByTabId: omitByTabId(s.nativeChatLaunchPromptByTabId),
      nativeChatLaunchDraftByTabId: omitByTabId(s.nativeChatLaunchDraftByTabId),
      unverifiedPtyLossTabIds: omitByTabId(s.unverifiedPtyLossTabIds),
      terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
      // Why: closeTab deletes these per-tab maps but removeWorktree missed them, leaking a split pane's expand flags.
      expandedPaneByTabId: omitByTabId(s.expandedPaneByTabId),
      canExpandPaneByTabId: omitByTabId(s.canExpandPaneByTabId),
      deleteStateByWorktreeId: removeDeleteStatesForWorktreeIds(
        s.deleteStateByWorktreeId,
        new Set(worktreeIds)
      ),
      baseStatusByWorktreeId: omitByWorktree(s.baseStatusByWorktreeId),
      remoteBranchConflictByWorktreeId: omitByWorktree(s.remoteBranchConflictByWorktreeId),
      // Why: file search state is worktree-scoped; clear it so another worktree can't inherit stale matches.
      fileSearchStateByWorktree: omitByWorktree(s.fileSearchStateByWorktree),
      // Why: these worktree-keyed maps are re-keyed on rename but were missed by removal, leaking one entry each.
      remoteStatusesByWorktree: omitByWorktree(s.remoteStatusesByWorktree),
      recentlyClosedEditorTabsByWorktree: omitByWorktree(s.recentlyClosedEditorTabsByWorktree),
      recentlyClosedTerminalTabsByWorktree: omitByWorktree(s.recentlyClosedTerminalTabsByWorktree),
      // Why: a deleted worktree's tabs can never be reopened; purge the kind list with the snapshot stacks above.
      recentlyClosedTabKindsByWorktree: omitByWorktree(s.recentlyClosedTabKindsByWorktree),
      defaultTerminalTabsAppliedByWorktreeId: omitByWorktree(
        s.defaultTerminalTabsAppliedByWorktreeId
      ),
      activeWorktreeId: removedActiveWorktree ? null : s.activeWorktreeId,
      activeWorkspaceExecutionHostId: removedActiveWorktree
        ? null
        : s.activeWorkspaceExecutionHostId,
      activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
      openFiles: nextOpenFiles,
      browserTabsByWorktree: omitByWorktree(s.browserTabsByWorktree),
      // Why: closeBrowserTab records a Cmd+Shift+T undo snapshot, but a deleted worktree's tabs can't be restored; purge it.
      recentlyClosedBrowserTabsByWorktree: omitByWorktree(s.recentlyClosedBrowserTabsByWorktree),
      activeFileIdByWorktree: omitByWorktree(s.activeFileIdByWorktree),
      activeBrowserTabIdByWorktree: omitByWorktree(s.activeBrowserTabIdByWorktree),
      activeTabTypeByWorktree: omitByWorktree(s.activeTabTypeByWorktree),
      rightSidebarExplorerViewByWorktree: omitByWorktree(s.rightSidebarExplorerViewByWorktree),
      activeTabIdByWorktree: omitByWorktree(s.activeTabIdByWorktree),
      // Why: the tab strip persists visual order per worktree; drop the entry so stale tab IDs aren't retained.
      tabBarOrderByWorktree: omitByWorktree(s.tabBarOrderByWorktree),
      pendingReconnectTabByWorktree: omitByWorktree(s.pendingReconnectTabByWorktree),
      // Why: split-tab layout/group state is worktree-owned; leaving it makes a deleted worktree look restorable.
      unifiedTabsByWorktree: omitByWorktree(s.unifiedTabsByWorktree),
      groupsByWorktree: omitByWorktree(s.groupsByWorktree),
      layoutByWorktree: omitByWorktree(s.layoutByWorktree),
      activeGroupIdByWorktree: omitByWorktree(s.activeGroupIdByWorktree),
      editorDrafts: omitByFileId(s.editorDrafts),
      markdownViewMode: omitByFileId(s.markdownViewMode),
      markdownRichModeSizeOverride: omitByFileId(s.markdownRichModeSizeOverride),
      editorViewMode: omitByFileId(s.editorViewMode),
      markdownFrontmatterVisible: omitByFileId(s.markdownFrontmatterVisible),
      // Why: editorCursorLine is keyed by fileId; clear it with the other per-file state so it doesn't leak.
      editorCursorLine: omitByFileId(s.editorCursorLine),
      showDotfilesByWorktree: omitByWorktree(s.showDotfilesByWorktree),
      expandedDirs: omitByWorktree(s.expandedDirs),
      // Why: clear the huge-status marker so it doesn't linger after the worktree is gone.
      gitStatusHugeByWorktree: omitByWorktree(s.gitStatusHugeByWorktree),
      // Why: git status/compare caches stop refreshing once the worktree is deleted; remove them so no stale badges/diffs linger.
      gitStatusByWorktree: omitByWorktree(s.gitStatusByWorktree),
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
      activeFileId: activeFileCleared ? null : s.activeFileId,
      activeBrowserTabId: removedActiveWorktree ? null : s.activeBrowserTabId,
      activeTabType: removedActiveWorktree || activeFileCleared ? 'terminal' : s.activeTabType,
      everActivatedWorktreeIds: s.everActivatedWorktreeIds.has(worktreeId)
        ? new Set([...s.everActivatedWorktreeIds].filter((id) => id !== worktreeId))
        : s.everActivatedWorktreeIds,
      lastVisitedAtByWorktreeId: removeWorktreeVisitEntries(
        s.lastVisitedAtByWorktreeId,
        new Set(worktreeIds),
        executionHostId
      ),
      sortEpoch: s.sortEpoch + 1
    }
  })
}
