import { useSourceControlDiffCommentNotes } from '../notes/use-diff-comment-notes'
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
export function useSourceControlPanelState() {
  const context = useSourceControlWorktreeContext()
  const storeActions = useSourceControlStoreActions()
  const {
    activeConnectionId,
    activeRepoSettings,
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
    worktreeMap
  })
  useSourceControlBranchLineTotalGate({
    activeWorktreeId,
    branchSummary,
    isBranchVisible,
    isFolder
  })
  const statusRefresh = useSourceControlStatusRefresh({
    activeRepoSettings,
    activeWorktreeId,
    worktreePath,
    activePushTarget: activeWorktree?.pushTarget,
    isFolder,
    repositoryHuge,
    activeConnectionId,
    activeWorktreeInstanceId,
    worktreeMap
  })

  return {
    ...context,
    ...storeActions,
    ...notes,
    ...viewState,
    ...operationState,
    ...statusRefresh
  }
}

export type SourceControlPanelState = ReturnType<typeof useSourceControlPanelState>
