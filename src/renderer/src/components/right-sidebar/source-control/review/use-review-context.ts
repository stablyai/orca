import type { SourceControlPanelState } from '../panel/use-panel-state'
import { useSourceControlBaseRefs } from '../sync/use-base-refs'
import { useSourceControlBranchCompare } from '../sync/use-branch-compare'
import { useSourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import { useSourceControlHostedReviewPolling } from './use-hosted-review-polling'
import { useSourceControlHostedReviewProviderHint } from './use-hosted-review-provider-hint'
import { useSourceControlHostedReviewState } from './use-hosted-review-state'
import { useSourceControlLinkedReviews } from './use-linked-reviews'
import { resolveSourceControlSuppressedGitHubPRState } from './suppressed-github-pr'

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
    hostedReviewEntryData,
    linkedPR: activeWorktree?.linkedPR ?? null,
    suppressedGitHubPR: activeWorktree?.suppressedGitHubPR ?? null
  })
  const {
    hasSuppressedGitHubPR,
    hostedReview,
    hostedReviewCreation,
    hostedReviewCreationProviderHintRef
  } = hostedReviewState
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
    activePrFromQueue: hasSuppressedGitHubPR ? null : activePrFromQueue,
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
  const suppressedGitHubPRState = resolveSourceControlSuppressedGitHubPRState({
    worktree: activeWorktree ?? null,
    isFolder,
    provider: providerHint.provisionalHostedReviewProvider,
    hasMatchingSuppressedPR: hasSuppressedGitHubPR,
    hostedReview,
    hostedReviewCreation,
    isHostedReviewCreationLoading: providerHint.isHostedReviewCreationLoading,
    hostedReviewCreationRequestFailed:
      providerHint.hostedReviewCreationRequestMatchesCurrent &&
      hostedReviewState.hostedReviewCreationRequestState?.status === 'failed'
  })

  return {
    ...hostedReviewState,
    ...baseRefs,
    ...branchCompare,
    ...createPrIntentTarget,
    ...linkedReviews,
    ...providerHint,
    suppressedGitHubPRState
  }
}

export type SourceControlReviewContext = ReturnType<typeof useSourceControlReviewContext>
