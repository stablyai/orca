import { useCallback } from 'react'
import { openGitHubPRLinkModal } from '../../hosted-review/provider-actions/github-pr-link-modal'
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
import { useRebaseAutoStashProbe } from '../sync/use-rebase-auto-stash-probe'
import { useOrcaRebaseMarker } from '../sync/use-orca-rebase-marker'
import { resolveSourceControlRebaseModel } from './base-rebase-state'
import { useSourceControlPanelFoundation } from './use-panel-foundation'
import { useChangeScopeSync } from './use-change-scope-sync'

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
    activeRepoTarget,
    activeWorktree,
    activeWorktreeId,
    branchEntries,
    branchName,
    branchSummary,
    canUseHostedReviewPushTarget,
    clearSelection,
    commitMessage,
    compareBaseRef,
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
    isRemoteOperationInAnotherWorktree,
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
    openModal,
    openCommittedDiff,
    refreshActiveGitStatusAfterMutation,
    remoteStatus,
    rebaseStop,
    rebaseStopInspectFailure,
    activeGitStatusHead,
    rebaseAutoStash,
    remoteStatusForActions,
    resolveSplitTargetGroupId,
    setIsExecutingBulk,
    sourceControlRef,
    suppressedGitHubPRState,
    unresolvedConflicts,
    worktreePath
  } = foundation
  const suppressPullAfterRebase = useOrcaRebaseMarker({
    branchName,
    operationStore: foundation.operationStore,
    orcaRebase: foundation.orcaRebase,
    remoteStatus
  })
  const {
    handleAbortMerge,
    handleAbortRebase,
    handleCommit,
    handleContinueRebase,
    runCompoundCommitAction,
    runRemoteAction
  } = commitFlows
  const { handleCreatePullRequest, prGenerating } = reviewFlows

  const rebaseModel = resolveSourceControlRebaseModel({
    summary: branchSummary,
    compareBaseRef,
    effectiveBaseRef,
    conflictOperation,
    unresolvedConflictCount: unresolvedConflicts.length,
    hasTrackedChanges: grouped.staged.length > 0 || grouped.unstaged.length > 0,
    rebaseAutoStash,
    rebaseStop,
    rebaseStopInspectFailure,
    indexObservation: foundation.rebaseIndexObservation,
    statusHead: activeGitStatusHead,
    isBusy:
      isCommitting ||
      isRemoteOperationActive ||
      isAbortingOperation ||
      prGenerating ||
      isCreatingPr ||
      isCreatePrIntentInFlight
  })
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
    isRemoteOperationInAnotherWorktree,
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
    hasSuppressedGitHubPRState: suppressedGitHubPRState !== null,
    conflictOperation,
    effectiveBaseRef,
    rebaseMenu: rebaseModel,
    suppressPullAfterRebase
  })
  const handleRelinkSuppressedGitHubPR = useCallback(() => {
    if (!activeWorktree || !activeWorktreeId || suppressedGitHubPRState?.status !== 'matched') {
      return
    }
    openGitHubPRLinkModal({
      openModal,
      worktree: activeWorktree,
      worktreeId: activeWorktreeId,
      currentPR: suppressedGitHubPRState.number
    })
  }, [activeWorktree, activeWorktreeId, openModal, suppressedGitHubPRState])
  const actionDispatch = useSourceControlActionDispatch({
    createPrHeaderAction: actionModel.createPrHeaderAction,
    handleAbortMerge,
    handleAbortRebase,
    handleCommit,
    handleContinueRebase,
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
  useRebaseAutoStashProbe({
    activeRepoTarget,
    activeWorktreeId,
    operationStore: foundation.operationStore,
    shouldProbe: rebaseModel.shouldProbeRebaseAutoStash,
    worktreePath
  })
  useSourceControlUpstreamStatusFetch({
    activeRepoTarget,
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
    activeRepoTarget,
    resolveSplitTargetGroupId
  })
  const retryCommitScopeFiles = useChangeScopeSync({
    changeScope: foundation.changeScope,
    setChangeScope: foundation.setChangeScope,
    setCommitScopeFiles: foundation.setCommitScopeFiles,
    gitHistoryState: foundation.gitHistoryState,
    statusHead: foundation.activeGitStatusHead ?? null,
    loadCommitFiles: gitHistoryCommitActions.loadCommitFiles
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
    activeRepoTarget,
    activeWorktreeId,
    worktreePath,
    refreshActiveGitStatusAfterMutation
  })
  const discardConfirmation = useSourceControlDiscardConfirmation({
    activeRepoTarget,
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
    baseRebaseState: rebaseModel.baseRebaseState,
    ...actionDispatch,
    ...gitHistoryCommitActions,
    ...noteOpening,
    ...entryMutations,
    ...discardConfirmation,
    retryCommitScopeFiles,
    handleRelinkSuppressedGitHubPR
  }
}

export type SourceControlPanelModel = ReturnType<typeof useSourceControlPanelModel>
