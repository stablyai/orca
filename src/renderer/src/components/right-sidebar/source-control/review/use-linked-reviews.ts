import { useMemo } from 'react'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo
} from '../../../../../../shared/hosted-review'
import {
  hasPositiveHostedReviewNumberLink,
  hasResolvableHostedReviewPushTargetLink,
  hasUsableHostedReviewPushTarget,
  resolveHostedReviewActionUpstreamStatus,
  resolveHostedReviewStateForActions
} from './hosted-review-push-target'
import { buildSourceControlManualReviewUrlFromContext } from './manual-review-url'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

/**
 * Reads the per-provider review links pinned to the worktree and derives everything the header and
 * remote actions need from them: the manual review URL, push-target usability, and the upstream
 * status the action model should act on.
 */
export function useSourceControlLinkedReviews({
  activePrFromQueue,
  activeRepo,
  activeWorktree,
  branchName,
  compareBaseRef,
  hostedReview,
  hostedReviewCreation,
  hostedReviewEntry,
  remoteStatus
}: {
  activePrFromQueue: SourceControlWorktreeContext['activePrFromQueue']
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  branchName: string
  compareBaseRef: string | null
  hostedReview: HostedReviewInfo | null
  hostedReviewCreation: HostedReviewCreationEligibility | null
  hostedReviewEntry: SourceControlWorktreeContext['hostedReviewEntry']
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
}) {
  const linkedGitHubPR = activeWorktree?.linkedPR ?? null
  const fallbackGitHubPRNumber = linkedGitHubPR == null ? (activePrFromQueue?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const linkedBitbucketPR = activeWorktree?.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = activeWorktree?.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = activeWorktree?.linkedGiteaPR ?? null
  const manualReviewUrl = useMemo(
    () =>
      buildSourceControlManualReviewUrlFromContext({
        hostedReviewProvider: hostedReview?.provider ?? null,
        hostedReviewCreationProvider: hostedReviewCreation?.provider ?? null,
        linkedGitHubPR,
        fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR,
        baseRef: compareBaseRef,
        branchName,
        repoRemoteName: activeRepo?.gitRemoteIdentity?.remoteName ?? null,
        repoRemoteUrl: activeRepo?.gitRemoteIdentity?.remoteUrl ?? null,
        pushTarget: activeWorktree?.pushTarget ?? null,
        upstreamName: remoteStatus?.upstreamName ?? null
      }),
    [
      activeRepo?.gitRemoteIdentity?.remoteName,
      activeRepo?.gitRemoteIdentity?.remoteUrl,
      activeWorktree?.pushTarget,
      branchName,
      compareBaseRef,
      fallbackGitHubPRNumber,
      hostedReview?.provider,
      hostedReviewCreation?.provider,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGitHubPR,
      linkedGitLabMR,
      linkedGiteaPR,
      remoteStatus?.upstreamName
    ]
  )
  const hasHostedReviewLink = hasPositiveHostedReviewNumberLink({
    linkedGitHubPR,
    fallbackGitHubPR: fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  })
  // Why: SSH-backed (connectionId) repos never fetch hostedReview, so skip the loading state or it would permanently block Publish Branch.
  const isHostedReviewStateLoading =
    !activeRepo?.connectionId && hasHostedReviewLink && hostedReviewEntry === undefined
  const hasResolvableReviewPushTargetLink = hasResolvableHostedReviewPushTargetLink({
    linkedGitHubPR,
    fallbackGitHubPR: fallbackGitHubPRNumber,
    linkedGitLabMR
  })
  const canUseHostedReviewPushTarget = hasUsableHostedReviewPushTarget({
    pushTarget: activeWorktree?.pushTarget,
    upstreamStatus: remoteStatus,
    hasResolvableHostedReviewPushTargetLink: hasResolvableReviewPushTargetLink,
    branchName
  })
  const hostedReviewStateForActions = resolveHostedReviewStateForActions({
    hostedReviewState: hostedReview?.state ?? null,
    hasResolvableHostedReviewPushTargetLink: hasResolvableReviewPushTargetLink
  })
  const remoteStatusForActions: SourceControlWorktreeContext['remoteStatus'] = useMemo(
    () =>
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink,
        hasResolvableHostedReviewPushTargetLink: hasResolvableReviewPushTargetLink,
        hostedReviewState: hostedReviewStateForActions,
        isHostedReviewStateLoading,
        canUseHostedReviewPushTarget,
        upstreamStatus: remoteStatus
      }),
    [
      canUseHostedReviewPushTarget,
      hasHostedReviewLink,
      hasResolvableReviewPushTargetLink,
      hostedReviewStateForActions,
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
    manualReviewUrl,
    remoteStatusForActions
  }
}

export type SourceControlLinkedReviews = ReturnType<typeof useSourceControlLinkedReviews>
