import type { SourceControlCommitFlows } from '../commit/use-commit-flows'
import type { SourceControlPanelFoundation } from '../panel/use-panel-foundation'
import { useSourceControlCreatePrIntentProbes } from './use-create-pr-intent-probes'
import { useSourceControlCreatePrIntentReview } from './use-create-pr-intent-review'
import { useSourceControlCreatePrIntentRun } from './use-create-pr-intent-run'
import type { SourceControlReviewFlows } from './use-review-flows'

/**
 * The one-click intent: commit, push and open a review in a single run. Reads its own git state
 * through dedicated probes rather than the panel's, so a stale render cannot mis-sequence the run.
 */
export function useSourceControlCreatePrIntentFlows(
  foundation: SourceControlPanelFoundation,
  commitFlows: SourceControlCommitFlows,
  reviewFlows: SourceControlReviewFlows
) {
  const {
    activeRepo,
    activeRepoSettings,
    activeWorktreeId,
    beginGitBranchCompareRequest,
    branchName,
    commitDraftsRef,
    commitErrorsRef,
    createHostedReview,
    createPrInFlightRef,
    createPrIntentActiveTargetConflicts,
    createPrIntentCurrentTargetRef,
    createPrIntentInFlightRef,
    createPrIntentRunStillOwnsWorktree,
    createPrIntentRunTokenRef,
    effectiveBaseRef,
    entries,
    fallbackGitHubPRNumber,
    getCreatePrIntentOperationTarget,
    getHostedReviewCreationEligibility,
    hostedReviewCreateCopy,
    isCommitting,
    isCreatingPr,
    isExecutingBulk,
    isFolder,
    isRemoteOperationActive,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR,
    provisionalHostedReviewProvider,
    remoteStatus,
    resolvedPrCreationDefaults,
    setCreatePrInFlightByWorktree,
    setCreatePrIntentInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    setGitBranchCompareResult,
    setGitStatus,
    setHostedReviewCreationState,
    setIsExecutingBulk,
    setUpstreamStatus,
    settings,
    updateCommitDrafts,
    updateWorktreeGitIdentity,
    worktreePath
  } = foundation
  const { generateCommitMessageForCreatePrIntent, handleCommit, isGenerating, runRemoteAction } =
    commitFlows
  const { handlePullRequestCreated, prBase, prBody, prGenerating } = reviewFlows

  const createPrIntentReview = useSourceControlCreatePrIntentReview({
    activeRepo,
    createHostedReview,
    createPrInFlightRef,
    createPrIntentActiveTargetConflicts,
    createPrIntentCurrentTargetRef,
    createPrIntentRunStillOwnsWorktree,
    getCreatePrIntentOperationTarget,
    handlePullRequestCreated,
    hostedReviewCreateCopy,
    prBase,
    prBody,
    resolvedPrCreationDefaults,
    setCreatePrInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    settings
  })
  const createPrIntentProbes = useSourceControlCreatePrIntentProbes({
    activeRepo,
    activeRepoSettings,
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
    commitDraftsRef,
    commitErrorsRef,
    createHostedReviewForCreatePrIntent: createPrIntentReview.createHostedReviewForCreatePrIntent,
    createPrIntentActiveTargetConflicts,
    createPrIntentInFlightRef,
    createPrIntentRunStillOwnsWorktree,
    createPrIntentRunTokenRef,
    effectiveBaseRef,
    entries,
    generateCommitMessageForCreatePrIntent,
    getCreatePrIntentOperationTarget,
    handleCommit,
    isCommitting,
    isCreatingPr,
    isExecutingBulk,
    isGenerating,
    isRemoteOperationActive,
    prGenerating,
    provisionalHostedReviewProvider,
    readHostedReviewCreationEligibilityForIntent:
      createPrIntentProbes.readHostedReviewCreationEligibilityForIntent,
    refreshBranchCompareForCreatePrIntent:
      createPrIntentProbes.refreshBranchCompareForCreatePrIntent,
    refreshGitStatusForCreatePrIntent: createPrIntentProbes.refreshGitStatusForCreatePrIntent,
    remoteStatus,
    runRemoteAction,
    setCreatePrIntentInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    setIsExecutingBulk,
    updateCommitDrafts,
    worktreePath
  })

  return { ...createPrIntentReview, ...createPrIntentProbes, ...createPrIntentRun }
}

export type SourceControlCreatePrIntentFlows = ReturnType<
  typeof useSourceControlCreatePrIntentFlows
>
