import type { SourceControlPanelFoundation } from '../panel/use-panel-foundation'
import { useSourceControlCreateReviewComposer } from './use-create-review-composer'
import { useSourceControlHostedReviewCreated } from './use-hosted-review-created'
import { useSourceControlHostedReviewCreation } from './use-hosted-review-creation'
import { useSourceControlHostedReviewEligibility } from './use-hosted-review-eligibility'
import { useSourceControlPullRequestGeneration } from './use-pull-request-generation'

export function useSourceControlReviewFlows(foundation: SourceControlPanelFoundation) {
  const {
    activeRepo,
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoPath,
    activeRepoTarget,
    activeWorktreeId,
    activeWorktree,
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
    activeRepoTarget,
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
    activeRepoTarget,
    activeWorktreeId,
    activeWorktree,
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
    activePullRequestGenerationKey: pullRequestGeneration.activePullRequestGenerationKey,
    activeRepo,
    activeWorktreeId,
    branchName,
    createHostedReview,
    createPrInFlightRef,
    createStackedHostedReview,
    handleGeneratePullRequestFields: createReviewComposer.handleGeneratePullRequestFields,
    handlePullRequestCreated: hostedReviewCreated.handlePullRequestCreated,
    hostedReviewCreateCopy,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    prAiGenerationEnabled: createReviewComposer.prAiGenerationEnabled,
    prBase,
    prBody,
    prDraft,
    prFieldRevisions: createReviewComposer.prFieldRevisions,
    prFieldsAreSeedPlaceholders: createReviewComposer.prFieldsAreSeedPlaceholders,
    prGenerating,
    prTitle,
    pullRequestFieldsInitialized: createReviewComposer.pullRequestFieldsInitialized,
    resolvedPrCreationDefaults,
    setCreatePrInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    settings,
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
