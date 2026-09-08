import { reviewHeadKey } from './git-review-push-authority'
import type { GitUpstreamStatus } from './git-status-types'
import type { GitPushTarget } from './worktree/types'

export function hasUsableHostedReviewPushTarget(args: {
  pushTarget?: GitPushTarget
  upstreamStatus?: GitUpstreamStatus
  hasResolvableHostedReviewPushTargetLink?: boolean
  branchName?: string
}): boolean {
  const identity = args.upstreamStatus?.upstreamIdentity
  if (args.pushTarget) {
    return (
      !!args.pushTarget.reviewHead &&
      args.upstreamStatus?.reviewPushAuthority?.kind === 'verified' &&
      reviewHeadKey(args.upstreamStatus.reviewPushAuthority.reviewHead) ===
        reviewHeadKey(args.pushTarget.reviewHead) &&
      identity?.selector.kind === 'named-remote' &&
      identity.selector.value === args.pushTarget.remoteName &&
      identity.mergeRef === `refs/heads/${args.pushTarget.branchName}`
    )
  }
  if (args.hasResolvableHostedReviewPushTargetLink) {
    // A branch match cannot identify the repository that owns a linked review.
    return false
  }
  return args.upstreamStatus?.hasConfiguredPushTarget === true
}
