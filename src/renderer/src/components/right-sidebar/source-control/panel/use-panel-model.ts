import { useGitHistoryCommitActions } from '../sync/use-git-history-commit-actions'
import { useSourceControlCommitFlows } from '../commit/use-commit-flows'
import { useSourceControlDiscardConfirmation } from '../commit/use-discard-confirmation'
import { useSourceControlEntryMutations } from '../commit/use-entry-mutations'
import { useSourceControlNoteOpening } from '../notes/use-note-opening'
import { useSourceControlActionDispatch } from '../review/use-action-dispatch'
import { useSourceControlActionModel } from '../review/use-action-model'
import { useSourceControlCreatePrIntentFlows } from '../review/use-create-pr-intent-flows'
import { useSourceControlReviewFlows } from '../review/use-review-flows'
import { useSourceControlUpstreamStatusFetch } from '../sync/use-upstream-status-fetch'
import { useSourceControlPanelFoundation } from './use-panel-foundation'

/**
 * The panel's single entry point: foundation, then the flows that act on it, then the action model
 * the chrome renders from. The rendered tree reads only this.
 */
export function useSourceControlPanelModel() {
  const foundation = useSourceControlPanelFoundation()
  const commitFlows = useSourceControlCommitFlows(foundation)
  const reviewFlows = useSourceControlReviewFlows(foundation)
  const createPrIntentFlows = useSourceControlCreatePrIntentFlows(
    foundation,
    commitFlows,
    reviewFlows
  )
  const {
    activeRepoSettings,
    activeWorktree,
    activeWorktreeId,
    branchEntries,
    branchName,
    branchSummary,
    canUseHostedReviewPushTarget,
    clearSelection,
    commitMessage,
    conflictOperation,
    effectiveBaseRef,
    entries,
    fetchUpstreamStatus,
    grouped,
    handleOpenDiff,
    handleStageAllPrimary,
    hostedReview,
    hostedReviewCreateCopy,
    hostedReviewCreation,
    hostedReviewCreationForHeader,
    hostedReviewStateForActions,
    inFlightRemoteOpKind,
    isAbortingOperation,
    isBranchVisible,
    isCommitting,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isExecutingBulk,
    isFolder,
    isHostedReviewCreationLoading,
    isHostedReviewStateLoading,
    isRemoteOperationActive,
    openCommittedDiff,
    refreshActiveGitStatusAfterMutation,
    remoteStatus,
    remoteStatusForActions,
    resolveSplitTargetGroupId,
    setIsExecutingBulk,
    sourceControlRef,
    unresolvedConflicts,
    worktreePath
  } = foundation
  const {
    handleAbortMerge,
    handleAbortRebase,
    handleCommit,
    runCompoundCommitAction,
    runRemoteAction
  } = commitFlows
  const { handleCreatePullRequest, prGenerating } = reviewFlows

  const actionModel = useSourceControlActionModel({
    grouped,
    commitMessage,
    unresolvedConflictCount: unresolvedConflicts.length,
    isCommitting,
    isRemoteOperationActive,
    isAbortingOperation,
    remoteStatusForActions,
    hostedReviewStateForActions,
    isHostedReviewStateLoading,
    inFlightRemoteOpKind,
    hostedReviewCreation,
    branchSummary,
    branchName,
    canUseHostedReviewPushTarget,
    isCreatePrIntentInFlight,
    remoteStatus,
    hostedReviewState: hostedReview?.state ?? null,
    hostedReviewCreationForHeader,
    isHostedReviewCreationLoading,
    prGenerating,
    isCreatingPr,
    hostedReviewReviewLabel: hostedReviewCreateCopy.reviewLabel,
    conflictOperation,
    effectiveBaseRef
  })
  const actionDispatch = useSourceControlActionDispatch({
    createPrHeaderAction: actionModel.createPrHeaderAction,
    handleAbortMerge,
    handleAbortRebase,
    handleCommit,
    handleCreatePullRequest,
    handleStageAllPrimary,
    isCreatePrIntentInFlight,
    isCreatingPr,
    primaryAction: actionModel.primaryAction,
    prGenerating,
    remoteStatus,
    remoteStatusForActions,
    runCompoundCommitAction,
    runCreatePrIntent: createPrIntentFlows.runCreatePrIntent,
    runRemoteAction
  })
  useSourceControlUpstreamStatusFetch({
    activeRepoSettings,
    activeWorktree,
    activeWorktreeId,
    fetchUpstreamStatus,
    isBranchVisible,
    isFolder,
    worktreePath
  })
  const gitHistoryCommitActions = useGitHistoryCommitActions({
    activeWorktreeId,
    worktreePath,
    activeRepoSettings,
    resolveSplitTargetGroupId
  })
  const noteOpening = useSourceControlNoteOpening({
    activeWorktreeId,
    worktreePath,
    entries,
    branchEntries,
    branchSummary,
    handleOpenDiff,
    openCommittedDiff,
    sourceControlRef
  })
  const entryMutations = useSourceControlEntryMutations({
    activeRepoSettings,
    activeWorktreeId,
    worktreePath,
    refreshActiveGitStatusAfterMutation
  })
  const discardConfirmation = useSourceControlDiscardConfirmation({
    activeRepoSettings,
    activeWorktreeId,
    worktreePath,
    grouped,
    isExecutingBulk,
    setIsExecutingBulk,
    clearSelection,
    discardMany: entryMutations.discardMany,
    discardSingle: entryMutations.discardSingle,
    refreshActiveGitStatusAfterMutation
  })

  return {
    ...foundation,
    ...commitFlows,
    ...reviewFlows,
    ...createPrIntentFlows,
    ...actionModel,
    ...actionDispatch,
    ...gitHistoryCommitActions,
    ...noteOpening,
    ...entryMutations,
    ...discardConfirmation
  }
}

export type SourceControlPanelModel = ReturnType<typeof useSourceControlPanelModel>
