import type { GitPushTarget, GitUpstreamStatus } from '../../../../shared/types'
import type { HostedReviewState } from '../../../../shared/hosted-review'
import { isPositiveHostedReviewNumber } from '../../../../shared/hosted-review'
import { getPublishTargetDisplayName } from '../../../../shared/git-publish-target-status'
import { gitRefTargetsBranchName } from '../../../../shared/git-remote-branch-name'

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
    // Why: a same-repo review's head is the checked-out branch, so a real
    // upstream tracking it is safe before the resolver hydrates. Fork/cross-repo
    // heads differ, so a mismatched or missing upstream stays blocked. The
    // review's remote is unknown pre-hydration, so this can only match the
    // branch leaf; the strict remote+branch check above takes over once known.
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
  // Why: only GitHub (including a queue-discovered same-repo fallbackGitHubPR,
  // whose head IS the checked-out branch) and GitLab links resolve to a push
  // target — this mirrors getHostedReviewPushTargetLookup in the worktrees store.
  // Omitting fallbackGitHubPR left worktrees without persisted linkedPR metadata
  // (e.g. child worktrees) blocked as "target unavailable" despite a real upstream.
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
  // Why: a linked review from any provider blocks unsafe pushes. Build on the
  // resolvable subset so the two helpers cannot drift — a resolvable link is by
  // definition also a blocking link; only the resolver-less providers are added.
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
    // Why: SSH-backed linked reviews may not fetch live review state, but
    // their explicit link metadata still needs target-safe push behavior.
    (args.hasResolvableHostedReviewPushTargetLink && !args.hostedReviewState) ||
    args.isHostedReviewStateLoading ||
    args.hostedReviewState === 'open' ||
    args.hostedReviewState === 'draft'
  if (
    args.hasHostedReviewLink &&
    hostedReviewMayStillNeedItsOwnTarget &&
    !args.canUseHostedReviewPushTarget
  ) {
    // Why: a linked hosted review can coexist with an unrelated branch upstream;
    // push/status actions must not use that upstream until the review target is known.
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
  // Why: SSH-backed linked reviews may not have live review state, but Publish
  // Branch is unsafe until the linked review target is usable.
  return args.hasResolvableHostedReviewPushTargetLink ? 'open' : null
}
