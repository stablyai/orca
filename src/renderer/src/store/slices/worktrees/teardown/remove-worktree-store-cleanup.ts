import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { forgetCombinedDiffViewsForWorktrees } from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import { removeDeleteStatesForWorktreeIds } from './worktree-delete-state'
import { removeWorktreeVisitEntries } from '@/lib/worktree-visit-recency'
import { forgetAmbiguousOwnerWarnings } from '@/lib/ambiguous-owner-warning'
import { omitRecordKeys } from './record-key-omission'
import { removeWorktreeLayout } from '../../tabs/worktree-layout-lifecycle'
import { omitSleepingAgentSessionsForWorktrees } from './sleeping-agent-session-omission'
import {
  noticeRemovedUnsavedFiles,
  type ConfirmedUnsavedDiscards
} from './removed-workspace-unsaved-files'

/** Clears worktree-owned renderer state after successful removal so a reused identity cannot inherit stale preferences. */
export function applyRemoveWorktreeSuccessState(
  set: WorktreeSliceSet,
  worktreeId: string,
  tabIds: Set<string>,
  executionHostId?: ExecutionHostId,
  confirmedDiscards?: ConfirmedUnsavedDiscards
): void {
  // Clear module caches outside store state; reused IDs must re-arm ambiguity warnings.
  forgetAmbiguousOwnerWarnings([worktreeId])
  forgetCombinedDiffViewsForWorktrees([worktreeId])
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
    const editorBufferKeepRequest = noticeRemovedUnsavedFiles(s, removedFileIds, confirmedDiscards)
    const omitByFileId = <T>(m: Record<string, T> | undefined) => omitRecordKeys(m, removedFileIds)
    const activeFileCleared = s.activeFileId
      ? s.openFiles.some((f) => f.id === s.activeFileId && f.worktreeId === worktreeId)
      : false
    const removedActiveWorktree = s.activeWorktreeId === worktreeId
    return {
      editorBufferKeepRequest,
      ...removeWorktreeLayout(s, {
        worktreeIds: new Set(worktreeIds),
        tabIds,
        activeFileCleared
      }),
      worktreesByRepo: nextWorktreesByRepo,
      worktreeLineageById: omitByWorktree(s.worktreeLineageById),
      workspaceLineageByChildKey: omitRecordKeys(s.workspaceLineageByChildKey, [
        worktreeWorkspaceKey(worktreeId)
      ]),
      runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
      automaticAgentResumeClaimsByTabId: omitByTabId(s.automaticAgentResumeClaimsByTabId),
      nativeChatLaunchPromptByTabId: omitByTabId(s.nativeChatLaunchPromptByTabId),
      nativeChatLaunchDraftByTabId: omitByTabId(s.nativeChatLaunchDraftByTabId),
      unverifiedPtyLossTabIds: omitByTabId(s.unverifiedPtyLossTabIds),
      localOnlyScrollbackByTabId: omitByTabId(s.localOnlyScrollbackByTabId),
      // Why: closeTab deletes these per-tab maps but removeWorktree missed them, leaking a split pane's expand flags.
      expandedPaneByTabId: omitByTabId(s.expandedPaneByTabId),
      canExpandPaneByTabId: omitByTabId(s.canExpandPaneByTabId),
      deleteStateByWorktreeId: removeDeleteStatesForWorktreeIds(
        s.deleteStateByWorktreeId,
        new Set(worktreeIds)
      ),
      baseStatusByWorktreeId: omitByWorktree(s.baseStatusByWorktreeId),
      remoteBranchConflictByWorktreeId: omitByWorktree(s.remoteBranchConflictByWorktreeId),
      fileSearchStateByWorktree: omitByWorktree(s.fileSearchStateByWorktree),
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
      // Why: closeBrowserTab records a Cmd+Shift+T undo snapshot, but a deleted worktree's tabs can't be restored; purge it.
      recentlyClosedBrowserTabsByWorktree: omitByWorktree(s.recentlyClosedBrowserTabsByWorktree),
      rightSidebarExplorerViewByWorktree: omitByWorktree(s.rightSidebarExplorerViewByWorktree),
      pendingReconnectTabByWorktree: omitByWorktree(s.pendingReconnectTabByWorktree),
      editorDrafts: omitByFileId(s.editorDrafts),
      markdownViewMode: omitByFileId(s.markdownViewMode),
      markdownRichModeSizeOverride: omitByFileId(s.markdownRichModeSizeOverride),
      editorViewMode: omitByFileId(s.editorViewMode),
      markdownFrontmatterVisible: omitByFileId(s.markdownFrontmatterVisible),
      editorCursorLine: omitByFileId(s.editorCursorLine),
      explorerDisplayRootByWorktree: omitByWorktree(s.explorerDisplayRootByWorktree),
      showDotfilesByWorktree: omitByWorktree(s.showDotfilesByWorktree),
      expandedDirs: omitByWorktree(s.expandedDirs),
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
      everActivatedWorktreeIds: s.everActivatedWorktreeIds.has(worktreeId)
        ? new Set([...s.everActivatedWorktreeIds].filter((id) => id !== worktreeId))
        : s.everActivatedWorktreeIds,
      lastVisitedAtByWorktreeId: removeWorktreeVisitEntries(
        s.lastVisitedAtByWorktreeId,
        new Set(worktreeIds),
        executionHostId
      ),
      // Provider-session events can reinsert worktree-scoped sleep records after terminal shutdown while teardown awaits (#24784).
      ...omitSleepingAgentSessionsForWorktrees(s, new Set(worktreeIds)),
      sortEpoch: s.sortEpoch + 1
    }
  })
}
