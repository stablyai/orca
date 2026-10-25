import type { SourceControlPanelState } from '../panel/use-panel-state'
import { useSourceControlBaseRefs } from '../sync/use-base-refs'
import { useSourceControlBranchCompare } from '../sync/use-branch-compare'
import { useSourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import { useSourceControlReviewPushTarget } from './use-review-push-target'
import { useSourceControlHostedReviewProviderHint } from './use-hosted-review-provider-hint'
import { useSourceControlHostedReviewState } from './use-hosted-review-state'
import { useSourceControlLinkedReviews } from './use-linked-reviews'
import { resolveSourceControlSuppressedGitHubPRState } from './suppressed-github-pr'

export function useSourceControlReviewContext(panelState: SourceControlPanelState) {
  const {
    activeGitStatusHead,
    activePrFromQueue,
    activeRepo,
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoTarget,
    activeWorktree,
    activeWorktreeId,
    branchName,
    createPrIntentCurrentTargetRef,
    ensureHostedReviewPushTarget,
    hostedReviewCacheKey,
    hostedReviewEntry,
    hostedReviewEntryData,
    isBranchVisible,
    isFolder,
    remoteStatus,
    settings,
    worktreePath
  } = panelState

  const hostedReviewState = useSourceControlHostedReviewState({
    activePrFromQueue,
    activeRepoId,
    activeWorktreeId,
    branchName,
    hostedReviewCacheKey,
    hostedReviewEntryData,
    currentHeadOid: activeWorktree?.head,
    linkedPR: activeWorktree?.linkedPR ?? null,
    suppressedGitHubPR: activeWorktree?.suppressedGitHubPR ?? null
  })
  const {
    currentPrFromQueue,
    hasSuppressedGitHubPR,
    hostedReview,
    hostedReviewCreation,
    hostedReviewCreationProviderHintRef
  } = hostedReviewState
  const baseRefs = useSourceControlBaseRefs({
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
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
    activeRepoTarget,
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
    activeWorktreeId,
    branchName,
    createPrIntentCurrentTargetRef,
    effectiveBaseRef,
    worktreePath
  })
  const linkedReviews = useSourceControlLinkedReviews({
    activePrFromQueue: hasSuppressedGitHubPR ? null : currentPrFromQueue,
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
  useSourceControlReviewPushTarget({
    activeWorktree,
    activeWorktreeId,
    ensureHostedReviewPushTarget,
    hasResolvableReviewPushTargetLink,
    isBranchVisible,
    isFolder
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
