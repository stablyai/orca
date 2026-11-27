import { useMemo } from 'react'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  hasPositiveHostedReviewNumberLink,
  hasResolvableHostedReviewPushTargetLink,
  resolveHostedReviewPushTargetForActions
} from '../../../../../../shared/source-control/hosted-review/hosted-review-push-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

export function useSourceControlLinkedReviews({
  activePrFromQueue,
  activeRepo,
  activeWorktree,
  branchName,
  hostedReview,
  hostedReviewEntry,
  remoteStatus
}: {
  activePrFromQueue: SourceControlWorktreeContext['activePrFromQueue']
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  branchName: string
  hostedReview: HostedReviewInfo | null
  hostedReviewEntry: SourceControlWorktreeContext['hostedReviewEntry']
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
}) {
  const linkedGitHubPR = activeWorktree?.linkedPR ?? null
  const fallbackGitHubPRNumber = linkedGitHubPR == null ? (activePrFromQueue?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const linkedBitbucketPR = activeWorktree?.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = activeWorktree?.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = activeWorktree?.linkedGiteaPR ?? null
  const hasHostedReviewLink = hasPositiveHostedReviewNumberLink({
    linkedGitHubPR,
    fallbackGitHubPR: fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  })
  // SSH repos never fetch live reviews; treating them as loading would permanently block Publish Branch.
  const isHostedReviewStateLoading =
    !activeRepo?.connectionId && hasHostedReviewLink && hostedReviewEntry === undefined
  const hasResolvableReviewPushTargetLink = hasResolvableHostedReviewPushTargetLink({
    linkedGitHubPR,
    fallbackGitHubPR: fallbackGitHubPRNumber,
    linkedGitLabMR
  })
  const {
    canUseHostedReviewPushTarget,
    hostedReviewStateForActions,
    upstreamStatusForActions: remoteStatusForActions
  } = useMemo(
    () =>
      resolveHostedReviewPushTargetForActions({
        hasHostedReviewLink,
        hasResolvableHostedReviewPushTargetLink: hasResolvableReviewPushTargetLink,
        hostedReviewState: hostedReview?.state ?? null,
        isHostedReviewStateLoading,
        pushTarget: activeWorktree?.pushTarget,
        upstreamStatus: remoteStatus,
        branchName
      }),
    [
      activeWorktree?.pushTarget,
      branchName,
      hasHostedReviewLink,
      hasResolvableReviewPushTargetLink,
      hostedReview?.state,
      isHostedReviewStateLoading,
      remoteStatus
    ]
  )

  return {
    canUseHostedReviewPushTarget,
    fallbackGitHubPRNumber,
    hasHostedReviewLink,
    hasResolvableReviewPushTargetLink,
    hostedReviewStateForActions,
    isHostedReviewStateLoading,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedGiteaPR,
    remoteStatusForActions
  }
}

export type SourceControlLinkedReviews = ReturnType<typeof useSourceControlLinkedReviews>
