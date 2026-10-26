import type { GitUpstreamStatus } from '../../../../../../shared/git-status-types'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import type { HostedReviewState } from '../../../../../../shared/hosted-review'
import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import { getPublishTargetDisplayName } from '../../../../../../shared/git-publish-target-status'
import { gitRefTargetsBranchName } from '../../../../../../shared/git-remote-branch-name'

export function hasUsableHostedReviewPushTarget(args: {
  pushTarget?: GitPushTarget
  upstreamStatus?: GitUpstreamStatus
  hasResolvableHostedReviewPushTargetLink?: boolean
  branchName?: string
}): boolean {
  if (args.pushTarget) {
    return (
      args.upstreamStatus === undefined ||
      args.upstreamStatus.upstreamName === getPublishTargetDisplayName(args.pushTarget)
    )
  }
  if (args.hasResolvableHostedReviewPushTargetLink) {
    // Before hydration, same-repo heads may match the upstream branch leaf; forks stay blocked until strict remote/branch matching is possible.
    return (
      args.upstreamStatus?.hasUpstream === true &&
      args.branchName !== undefined &&
      gitRefTargetsBranchName(args.upstreamStatus.upstreamName, args.branchName)
    )
  }
  return args.upstreamStatus?.hasConfiguredPushTarget === true
}

export function hasResolvableHostedReviewPushTargetLink(args: {
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
}): boolean {
  // Include queue-discovered same-repo reviews so child worktrees without persisted links can resolve their push target.
  return (
    isPositiveHostedReviewNumber(args.linkedGitHubPR) ||
    isPositiveHostedReviewNumber(args.fallbackGitHubPR) ||
    isPositiveHostedReviewNumber(args.linkedGitLabMR)
  )
}

export function hasPositiveHostedReviewNumberLink(args: {
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}): boolean {
  // Build on resolvable links so every resolvable provider also blocks unsafe pushes.
  return (
    hasResolvableHostedReviewPushTargetLink(args) ||
    isPositiveHostedReviewNumber(args.linkedBitbucketPR) ||
    isPositiveHostedReviewNumber(args.linkedAzureDevOpsPR) ||
    isPositiveHostedReviewNumber(args.linkedGiteaPR)
  )
}

export function resolveHostedReviewActionUpstreamStatus(args: {
  hasHostedReviewLink: boolean
  hasResolvableHostedReviewPushTargetLink: boolean
  hostedReviewState?: HostedReviewState | null
  isHostedReviewStateLoading: boolean
  canUseHostedReviewPushTarget: boolean
  upstreamStatus?: GitUpstreamStatus
}): GitUpstreamStatus | undefined {
  const hostedReviewMayStillNeedItsOwnTarget =
    // SSH reviews may lack live state; explicit links still require a safe target.
    (args.hasResolvableHostedReviewPushTargetLink && !args.hostedReviewState) ||
    args.isHostedReviewStateLoading ||
    args.hostedReviewState === 'open' ||
    args.hostedReviewState === 'draft'
  if (
    args.hasHostedReviewLink &&
    hostedReviewMayStillNeedItsOwnTarget &&
    !args.canUseHostedReviewPushTarget
  ) {
    // Linked reviews can have unrelated upstreams; hide that upstream until their own target resolves.
    return { hasUpstream: false, ahead: 0, behind: 0 }
  }
  return args.upstreamStatus
}

export function resolveHostedReviewStateForActions(args: {
  hostedReviewState?: HostedReviewState | null
  hasResolvableHostedReviewPushTargetLink: boolean
}): HostedReviewState | null {
  if (args.hostedReviewState) {
    return args.hostedReviewState
  }
  // SSH links without live state still block Publish Branch until their target is usable.
  return args.hasResolvableHostedReviewPushTargetLink ? 'open' : null
}
