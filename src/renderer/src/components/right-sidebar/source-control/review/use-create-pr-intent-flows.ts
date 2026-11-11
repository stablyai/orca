import type { SourceControlCommitFlows } from '../commit/use-commit-flows'
import type { SourceControlPanelFoundation } from '../panel/use-panel-foundation'
import { useSourceControlCreatePrIntentProbes } from './use-create-pr-intent-probes'
import { useSourceControlCreatePrIntentReview } from './use-create-pr-intent-review'
import { useSourceControlCreatePrIntentRun } from './use-create-pr-intent-run'
import type { SourceControlReviewFlows } from './use-review-flows'

/** Probe Git between intent steps so stale panel renders cannot mis-sequence commit/push/review. */
export function useSourceControlCreatePrIntentFlows(
  foundation: SourceControlPanelFoundation,
  commitFlows: SourceControlCommitFlows,
  reviewFlows: SourceControlReviewFlows
) {
  const {
    activeRepo,
    activeWorktreeId,
    beginGitBranchCompareRequest,
    branchName,
    createHostedReview,
    effectiveBaseRef,
    entries,
    fallbackGitHubPRNumber,
    getCreatePrIntentOperationTarget,
    getHostedReviewCreationEligibility,
    hostedReviewCreateCopy,
    isExecutingBulk,
    isFolder,
    isRemoteOperationActive,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR,
    operationStore,
    provisionalHostedReviewProvider,
    remoteStatus,
    setGitBranchCompareResult,
    setGitStatus,
    setHostedReviewCreationState,
    setIsExecutingBulk,
    setUpstreamStatus,
    updateCommitDraft,
    updateWorktreeGitIdentity,
    worktreePath
  } = foundation
  const { generateCommitMessageForCreatePrIntent, handleCommit, isGenerating, runRemoteAction } =
    commitFlows
  const { handlePullRequestCreated, prBase, prBody, prGenerating } = reviewFlows

  const createPrIntentReview = useSourceControlCreatePrIntentReview({
    activeRepo,
    createHostedReview,
    getCreatePrIntentOperationTarget,
    handlePullRequestCreated,
    hostedReviewCreateCopy,
    operationStore,
    prBase,
    prImageUploadPendingRef: reviewFlows.prImageUploadPendingRef,
    prBody
  })
  const createPrIntentProbes = useSourceControlCreatePrIntentProbes({
    activeRepo,
    beginGitBranchCompareRequest,
    fallbackGitHubPRNumber,
    getCreatePrIntentOperationTarget,
    getHostedReviewCreationEligibility,
    isFolder,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR,
    setGitBranchCompareResult,
    setGitStatus,
    setHostedReviewCreationState,
    setUpstreamStatus,
    updateWorktreeGitIdentity
  })
  const createPrIntentRun = useSourceControlCreatePrIntentRun({
    activeRepo,
    activeWorktreeId,
    branchName,
    createHostedReviewForCreatePrIntent: createPrIntentReview.createHostedReviewForCreatePrIntent,
    effectiveBaseRef,
    entries,
    generateCommitMessageForCreatePrIntent,
    getCreatePrIntentOperationTarget,
    handleCommit,
    isExecutingBulk,
    isGenerating,
    isRemoteOperationActive,
    operationStore,
    prGenerating,
    provisionalHostedReviewProvider,
    readHostedReviewCreationEligibilityForIntent:
      createPrIntentProbes.readHostedReviewCreationEligibilityForIntent,
    refreshBranchCompareForCreatePrIntent:
      createPrIntentProbes.refreshBranchCompareForCreatePrIntent,
    refreshGitStatusForCreatePrIntent: createPrIntentProbes.refreshGitStatusForCreatePrIntent,
    remoteStatus,
    runRemoteAction,
    setIsExecutingBulk,
    updateCommitDraft,
    worktreePath
  })

  return { ...createPrIntentReview, ...createPrIntentProbes, ...createPrIntentRun }
}

export type SourceControlCreatePrIntentFlows = ReturnType<
  typeof useSourceControlCreatePrIntentFlows
>
