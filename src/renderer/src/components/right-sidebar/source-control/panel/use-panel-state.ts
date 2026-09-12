import { useAppStore } from '@/store'
import { useSourceControlDiffCommentNotes } from '../notes/use-diff-comment-notes'
import { useSourceControlStoreActions } from '../listing/use-store-actions'
import { useSourceControlWorktreeContext } from '../listing/use-worktree-context'
import { useSourceControlBranchLineTotalGate } from '../sync/use-branch-line-total-gate'
import { useSourceControlStatusRefresh } from '../sync/use-status-refresh'
import { useSourceControlPanelViewState } from './use-panel-view-state'
import { useSourceControlViewWorktreeSelection } from './use-source-control-view-worktree-selection'
import { useSourceControlWorktreeOperationState } from './use-worktree-operation-state'

/**
 * The panel's ground floor: what worktree/repo is being shown (the picker subject, defaulting to
 * the app-active worktree), the store actions it drives, and the state it owns itself. Everything
 * else in the panel is derived from this.
 */
export function useSourceControlPanelState() {
  const settings = useAppStore((s) => s.settings)
  const storeActions = useSourceControlStoreActions()
  const selection = useSourceControlViewWorktreeSelection()
  const context = useSourceControlWorktreeContext(selection.subjectWorktreeId)
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
    worktreeMap,
    worktreePath
  } = context
  // Why: view state is keyed to the shown worktree so picking another one starts with a fresh view.
  const viewState = useSourceControlPanelViewState({
    activeWorktreeId,
    settings,
    updateSettings: storeActions.updateSettings
  })

  const notes = useSourceControlDiffCommentNotes({
    activeWorktreeId,
    clearDiffComments: storeActions.clearDiffComments,
    clearDiffCommentsForFile: storeActions.clearDiffCommentsForFile
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
    ...statusRefresh,
    setViewWorktreeId: selection.setViewWorktreeId
  }
}

export type SourceControlPanelState = ReturnType<typeof useSourceControlPanelState>
