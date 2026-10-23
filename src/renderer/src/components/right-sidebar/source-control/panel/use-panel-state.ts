import { useCallback } from 'react'
import { nestedStatusKey } from '@/lib/nested-status-key'
import { useSourceControlDiffCommentNotes } from '../notes/use-diff-comment-notes'
import type { NestedRepoTarget } from '../nested/use-nested-folder-scope'
import { useSourceControlStoreActions } from '../listing/use-store-actions'
import { useSourceControlWorktreeContext } from '../listing/use-worktree-context'
import { useSourceControlBranchLineTotalGate } from '../sync/use-branch-line-total-gate'
import { useSourceControlStatusRefresh } from '../sync/use-status-refresh'
import { useSourceControlPanelViewState } from './use-panel-view-state'
import { useSourceControlWorktreeOperationState } from './use-worktree-operation-state'

/**
 * The panel's ground floor: what worktree/repo is active, the store actions it drives, and the
 * state it owns itself. Everything else in the panel is derived from this.
 */
export function useSourceControlPanelState(nestedTarget?: NestedRepoTarget) {
  const context = useSourceControlWorktreeContext(nestedTarget?.path)
  const storeActions = useSourceControlStoreActions()
  const {
    activeConnectionId,
    activeRepoTarget,
    activeWorktree,
    activeWorktreeId,
    activeWorktreeInstanceId,
    branchSummary,
    conflictOperationsByWorktree,
    isBranchVisible,
    isFolder,
    repositoryHuge,
    settings,
    worktreeMap,
    worktreePath
  } = context

  const notes = useSourceControlDiffCommentNotes({
    activeWorktreeId,
    clearDiffComments: storeActions.clearDiffComments,
    clearDiffCommentsForFile: storeActions.clearDiffCommentsForFile
  })
  const viewState = useSourceControlPanelViewState({
    activeWorktreeId,
    settings,
    updateSettings: storeActions.updateSettings
  })
  const operationState = useSourceControlWorktreeOperationState({
    activeWorktreeId,
    conflictOperationsByWorktree,
    worktreeMap,
    nestedDraftKey:
      nestedTarget && activeWorktreeId
        ? nestedStatusKey(activeWorktreeId, nestedTarget.path)
        : undefined
  })
  useSourceControlBranchLineTotalGate({
    activeWorktreeId,
    branchSummary,
    isBranchVisible: isBranchVisible && !nestedTarget,
    isFolder
  })
  const statusRefresh = useSourceControlStatusRefresh({
    activeRepoTarget,
    activeWorktreeId,
    worktreePath,
    activePushTarget: activeWorktree?.pushTarget,
    isFolder,
    repositoryHuge,
    activeConnectionId,
    activeWorktreeInstanceId,
    worktreeMap
  })
  const nestedGitTarget = nestedTarget?.path ?? null
  const refreshNestedFolder = nestedTarget?.refresh
  const refreshParentGitStatus = statusRefresh.refreshActiveGitStatusAfterMutation
  const refreshActiveGitStatusAfterMutation = useCallback(async (): Promise<void> => {
    if (refreshNestedFolder) {
      await refreshNestedFolder()
      return
    }
    await refreshParentGitStatus()
  }, [refreshNestedFolder, refreshParentGitStatus])

  return {
    ...context,
    isNestedRepo: Boolean(nestedTarget),
    ...storeActions,
    ...notes,
    ...viewState,
    ...operationState,
    ...statusRefresh,
    refreshActiveGitStatusAfterMutation,
    worktreePath: nestedGitTarget ?? worktreePath,
    filterQuery: nestedTarget?.filterQuery ?? viewState.filterQuery,
    entries: nestedTarget?.entries ?? context.entries,
    branchName: nestedTarget?.branch ?? context.branchName,
    hasUncommittedEntries: nestedTarget
      ? nestedTarget.entries.length > 0
      : context.hasUncommittedEntries,
    branchEntries: nestedGitTarget ? [] : context.branchEntries,
    branchSummary: nestedGitTarget ? null : context.branchSummary,
    branchLineTotal: nestedGitTarget ? null : context.branchLineTotal
  }
}

export type SourceControlPanelState = ReturnType<typeof useSourceControlPanelState>
