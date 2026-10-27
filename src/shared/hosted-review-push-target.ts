import type { GitUpstreamStatus } from './git-status-types'
import type { GitPushTarget } from './worktree/types'
import type { HostedReviewState } from './hosted-review'
import { isPositiveHostedReviewNumber } from './hosted-review'
import { getPublishTargetDisplayName } from './git-publish-target-status'
import { gitRefTargetsBranchName } from './git-remote-branch-name'

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

export type HostedReviewPushTargetForActions = {
  canUseHostedReviewPushTarget: boolean
  hostedReviewStateForActions: HostedReviewState | null
  upstreamStatusForActions: GitUpstreamStatus | undefined
}

/** The commit area's view of a linked review: whether its own target can be pushed, and which upstream to act on. */
export function resolveHostedReviewPushTargetForActions(args: {
  hasHostedReviewLink: boolean
  hasResolvableHostedReviewPushTargetLink: boolean
  hostedReviewState?: HostedReviewState | null
  isHostedReviewStateLoading: boolean
  pushTarget?: GitPushTarget
  upstreamStatus?: GitUpstreamStatus
  branchName?: string
}): HostedReviewPushTargetForActions {
  const canUseHostedReviewPushTarget = hasUsableHostedReviewPushTarget({
    pushTarget: args.pushTarget,
    upstreamStatus: args.upstreamStatus,
    hasResolvableHostedReviewPushTargetLink: args.hasResolvableHostedReviewPushTargetLink,
    branchName: args.branchName
  })
  const hostedReviewStateForActions = resolveHostedReviewStateForActions({
    hostedReviewState: args.hostedReviewState ?? null,
    hasResolvableHostedReviewPushTargetLink: args.hasResolvableHostedReviewPushTargetLink
  })
  return {
    canUseHostedReviewPushTarget,
    hostedReviewStateForActions,
    upstreamStatusForActions: resolveHostedReviewActionUpstreamStatus({
      hasHostedReviewLink: args.hasHostedReviewLink,
      hasResolvableHostedReviewPushTargetLink: args.hasResolvableHostedReviewPushTargetLink,
      hostedReviewState: hostedReviewStateForActions,
      isHostedReviewStateLoading: args.isHostedReviewStateLoading,
      canUseHostedReviewPushTarget,
      upstreamStatus: args.upstreamStatus
    })
  }
}
