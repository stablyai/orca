import type { SourceControlPanelState } from '../panel/use-panel-state'
import { useSourceControlBaseRefs } from '../sync/use-base-refs'
import { useSourceControlBranchCompare } from '../sync/use-branch-compare'
import { useSourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import { useSourceControlHostedReviewPolling } from './use-hosted-review-polling'
import { useSourceControlHostedReviewProviderHint } from './use-hosted-review-provider-hint'
import { useSourceControlHostedReviewState } from './use-hosted-review-state'
import { useSourceControlLinkedReviews } from './use-linked-reviews'

/**
 * Resolves what review the active branch belongs to and which refs it is compared against — the
 * facts every review action later reads, before any of them can run.
 */
export function useSourceControlReviewContext(panelState: SourceControlPanelState) {
  const {
    activeGitStatusHead,
    activePrFromQueue,
    activeRepo,
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoRuntimeEnvironmentId,
    activeRepoSettings,
    activeWorktree,
    activeWorktreeId,
    branchName,
    createPrIntentCurrentTargetRef,
    enqueueGitHubPRRefresh,
    ensureHostedReviewPushTarget,
    fetchHostedReviewForBranch,
    hostedReviewCacheKey,
    hostedReviewEntry,
    hostedReviewEntryData,
    isBranchVisible,
    isFolder,
    remoteStatus,
    settings,
    worktreeMap,
    worktreePath
  } = panelState

  const hostedReviewState = useSourceControlHostedReviewState({
    activePrFromQueue,
    activeRepoId,
    activeWorktreeId,
    branchName,
    hostedReviewCacheKey,
    hostedReviewEntryData
  })
  const { hostedReview, hostedReviewCreation, hostedReviewCreationProviderHintRef } =
    hostedReviewState
  const baseRefs = useSourceControlBaseRefs({
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoRuntimeEnvironmentId,
    activeRepoWorktreeBaseRef: activeRepo?.worktreeBaseRef,
    activeWorktreeBaseRef: activeWorktree?.baseRef,
    hostedReview,
    isBranchVisible,
    isFolder,
    remoteStatus,
    settings
  })
  const { compareBaseRef, effectiveBaseRef } = baseRefs
  const branchCompare = useSourceControlBranchCompare({
    activeRepoSettings,
    activeWorktreeId,
    worktreePath,
    compareBaseRef,
    isFolder,
    branchName,
    isBranchVisible,
    activeGitStatusHead,
    remoteStatus
  })
  const createPrIntentTarget = useSourceControlCreatePrIntentTarget({
    activeRepoId,
    activeRepoSettings,
    activeWorktreeId,
    branchName,
    createPrIntentCurrentTargetRef,
    effectiveBaseRef,
    worktreeMap,
    worktreePath
  })
  const linkedReviews = useSourceControlLinkedReviews({
    activePrFromQueue,
    activeRepo,
    activeWorktree,
    branchName,
    compareBaseRef,
    hostedReview,
    hostedReviewCreation,
    hostedReviewEntry,
    remoteStatus
  })
  const {
    fallbackGitHubPRNumber,
    hasResolvableReviewPushTargetLink,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR
  } = linkedReviews
  const providerHint = useSourceControlHostedReviewProviderHint({
    activeRepo,
    activeRepoId,
    activeWorktreeId,
    branchName,
    fallbackGitHubPRNumber,
    hostedReview,
    hostedReviewCreation,
    hostedReviewCreationProviderHintRef,
    hostedReviewCreationRequestState: hostedReviewState.hostedReviewCreationRequestState,
    isBranchVisible,
    isFolder,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR
  })
  useSourceControlHostedReviewPolling({
    activeRepo,
    activeWorktree,
    activeWorktreeId,
    branchName,
    enqueueGitHubPRRefresh,
    ensureHostedReviewPushTarget,
    fallbackGitHubPRNumber,
    fetchHostedReviewForBranch,
    hasResolvableReviewPushTargetLink,
    isBranchVisible,
    isFolder,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR
  })

  return {
    ...hostedReviewState,
    ...baseRefs,
    ...branchCompare,
    ...createPrIntentTarget,
    ...linkedReviews,
    ...providerHint
  }
}

export type SourceControlReviewContext = ReturnType<typeof useSourceControlReviewContext>
