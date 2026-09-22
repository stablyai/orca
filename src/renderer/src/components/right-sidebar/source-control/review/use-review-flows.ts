import type { SourceControlPanelFoundation } from '../panel/use-panel-foundation'
import { useSourceControlCreateReviewComposer } from './use-create-review-composer'
import { useSourceControlHostedReviewCreated } from './use-hosted-review-created'
import { useSourceControlHostedReviewCreation } from './use-hosted-review-creation'
import { useSourceControlHostedReviewEligibility } from './use-hosted-review-eligibility'
import { useSourceControlPullRequestGeneration } from './use-pull-request-generation'

/**
 * The hand-driven review path: draft the fields, keep eligibility fresh while they are edited, and
 * create the review on the host.
 */
export function useSourceControlReviewFlows(foundation: SourceControlPanelFoundation) {
  const {
    activeRepo,
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoPath,
    activeRepoSettings,
    activeWorktreeId,
    allocatePullRequestGenerationRequestId,
    branchName,
    createHostedReview,
    createPrInFlightRef,
    createStackedHostedReview,
    effectiveBaseRef,
    fallbackGitHubPRNumber,
    fetchHostedReviewForBranch,
    fetchPRForBranch,
    getHostedReviewCreationEligibility,
    hasUncommittedEntries,
    hostedReviewCreateCopy,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    hostedReviewCreationProviderHintRef,
    isBranchVisible,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isFolder,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR,
    openPullRequestGenerationDialog,
    prGenerationRecords,
    provisionalHostedReviewProvider,
    refreshActiveGitStatusAfterMutation,
    refreshGitStatusAfterPullRequestGeneration,
    remoteStatus,
    resolvedPrCreationDefaults,
    setCreatePrInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    setHostedReviewCreationRequestState,
    setHostedReviewCreationState,
    setPullRequestGenerationRecord,
    setRightSidebarOpen,
    setRightSidebarTab,
    settings,
    sourceControlAiActionsVisible,
    updatePullRequestGenerationRecord,
    updateWorktreeMeta,
    worktreePath
  } = foundation

  const hostedReviewCreated = useSourceControlHostedReviewCreated({
    activeRepo,
    activeWorktreeId,
    branchName,
    fallbackGitHubPRNumber,
    fetchHostedReviewForBranch,
    fetchPRForBranch,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR,
    refreshActiveGitStatusAfterMutation,
    setRightSidebarOpen,
    setRightSidebarTab,
    updateWorktreeMeta
  })
  const pullRequestGeneration = useSourceControlPullRequestGeneration({
    activeRepo,
    activeRepoSettings,
    activeWorktreeId,
    allocatePullRequestGenerationRequestId,
    branchName,
    hostedReviewCreateProvider,
    prGenerationRecords,
    refreshGitStatusAfterPullRequestGeneration,
    resolvedPrCreationDefaults,
    setPullRequestGenerationRecord,
    updatePullRequestGenerationRecord,
    worktreePath
  })
  const createReviewComposer = useSourceControlCreateReviewComposer({
    activePullRequestGenerationKey: pullRequestGeneration.activePullRequestGenerationKey,
    activePullRequestGenerationRecord: pullRequestGeneration.activePullRequestGenerationRecord,
    activePullRequestGenerationSeedRestoreKey:
      pullRequestGeneration.activePullRequestGenerationSeedRestoreKey,
    activeRepo,
    activeRepoSettings,
    activeWorktreeId,
    branchName,
    effectiveBaseRef,
    fetchHostedReviewForBranch,
    handleBranchChangedByPullRequestGeneration:
      hostedReviewCreated.handleBranchChangedByPullRequestGeneration,
    handleCancelGeneratePullRequestFieldsForActive:
      pullRequestGeneration.handleCancelGeneratePullRequestFieldsForActive,
    handleGeneratePullRequestFieldsForActive:
      pullRequestGeneration.handleGeneratePullRequestFieldsForActive,
    handlePullRequestGenerationSeedRestored:
      pullRequestGeneration.handlePullRequestGenerationSeedRestored,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    isCreatingPr,
    openPullRequestGenerationDialog,
    resolvedPrCreationDefaults,
    settings,
    sourceControlAiActionsVisible,
    updatePullRequestGenerationRecord,
    worktreePath
  })
  const { prBase, prBody, prDraft, prGenerating, prTitle } = createReviewComposer

  useSourceControlHostedReviewEligibility({
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoPath,
    activeWorktreeId,
    branchName,
    effectiveBaseRef,
    fallbackGitHubPRNumber,
    getHostedReviewCreationEligibility,
    hasUncommittedEntries,
    isBranchVisible,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isFolder,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR,
    prGenerating,
    provisionalHostedReviewProvider,
    remoteStatus,
    hostedReviewCreationProviderHintRef,
    setHostedReviewCreationRequestState,
    setHostedReviewCreationState,
    worktreePath
  })
  const hostedReviewCreationAction = useSourceControlHostedReviewCreation({
    activeRepo,
    activeWorktreeId,
    branchName,
    createHostedReview,
    createPrInFlightRef,
    createStackedHostedReview,
    handlePullRequestCreated: hostedReviewCreated.handlePullRequestCreated,
    hostedReviewCreateCopy,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    prBase,
    prBody,
    prDraft,
    prGenerating,
    prTitle,
    resolvedPrCreationDefaults,
    setCreatePrInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    worktreePath
  })

  return {
    ...hostedReviewCreated,
    ...pullRequestGeneration,
    ...createReviewComposer,
    ...hostedReviewCreationAction
  }
}

export type SourceControlReviewFlows = ReturnType<typeof useSourceControlReviewFlows>
