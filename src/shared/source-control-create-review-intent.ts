import { isBehindOnlyUpstream, shouldForcePushWithLeaseForUpstream } from './git-upstream-status'
import { supportsHostedReviewCreation } from './hosted-review-creation-providers'
import type { GitUpstreamStatus } from './git-status-types'

export type CreateReviewIntentKind =
  | 'dirty'
  | 'message_required'
  | 'no_upstream'
  | 'needs_push'
  | 'needs_sync'
  | 'force_push'

export type CreateReviewIntentEligibility = {
  eligible: boolean
  kind: CreateReviewIntentKind | null
}

export function resolveCreateReviewIntentEligibility({
  stagedCount,
  hasStageableChanges,
  hasMessage,
  hasUnresolvedConflicts,
  upstreamStatus,
  hostedReviewCreation,
  branchCommitsAhead,
  hasCurrentBranch = true
}: {
  stagedCount: number
  hasStageableChanges: boolean
  hasMessage: boolean
  hasUnresolvedConflicts: boolean
  upstreamStatus: GitUpstreamStatus | undefined
  // Strings, not the closed unions: mobile round-trips tokens newer hosts add.
  hostedReviewCreation?: {
    provider: string
    canCreate?: boolean
    blockedReason?: string | null
    reviewLookupOutcome?: string
    defaultBaseRef?: string | null
  } | null
  branchCommitsAhead?: number
  hasCurrentBranch?: boolean
}): CreateReviewIntentEligibility {
  if (
    hasUnresolvedConflicts ||
    !hasCurrentBranch ||
    !hostedReviewCreation ||
    hostedReviewCreation.canCreate ||
    !supportsHostedReviewCreation(hostedReviewCreation.provider)
  ) {
    return { eligible: false, kind: null }
  }

  if (
    hostedReviewCreation.reviewLookupOutcome === 'unavailable' &&
    !hostedReviewCreation.defaultBaseRef?.trim()
  ) {
    return { eligible: false, kind: null }
  }

  // Branch preparation needs no lookup authority; create preflight still fails closed against duplicates.
  if (hostedReviewCreation.blockedReason === 'dirty') {
    if (stagedCount > 0 && !hasMessage) {
      return { eligible: true, kind: 'message_required' }
    }
    return { eligible: stagedCount > 0 || hasStageableChanges, kind: 'dirty' }
  }

  if (hostedReviewCreation.blockedReason === 'no_upstream') {
    const hasPublishableCommits = branchCommitsAhead === undefined ? false : branchCommitsAhead > 0
    return {
      eligible: hasPublishableCommits || stagedCount > 0 || hasStageableChanges,
      kind: 'no_upstream'
    }
  }

  if (hostedReviewCreation.blockedReason === 'needs_push') {
    return { eligible: true, kind: 'needs_push' }
  }

  if (
    hostedReviewCreation.blockedReason === 'needs_sync' &&
    shouldForcePushWithLeaseForUpstream(upstreamStatus)
  ) {
    return { eligible: true, kind: 'force_push' }
  }

  // Behind-only allows ff-only preparation; divergence requires the user’s explicit sync step.
  if (hostedReviewCreation.blockedReason === 'needs_sync' && isBehindOnlyUpstream(upstreamStatus)) {
    return { eligible: true, kind: 'needs_sync' }
  }

  return { eligible: false, kind: null }
}

export type CreatePrIntentRemoteStep =
  | 'publish'
  | 'push'
  | 'force_push'
  | 'fast_forward'
  | 'blocked'
  | 'none'

export function resolveCreatePrIntentRemoteStep({
  upstreamStatus,
  hostedReviewCreation,
  branchCommitsAhead,
  hasCurrentBranch
}: {
  upstreamStatus: GitUpstreamStatus | undefined
  // Strings, not the closed union: mobile round-trips reasons newer hosts add.
  hostedReviewCreation?: { canCreate?: boolean; blockedReason?: string | null } | null
  branchCommitsAhead?: number
  hasCurrentBranch: boolean
}): CreatePrIntentRemoteStep {
  if (!hasCurrentBranch || !hostedReviewCreation || hostedReviewCreation.canCreate) {
    return 'none'
  }

  if (hostedReviewCreation.blockedReason === 'no_upstream') {
    return branchCommitsAhead && branchCommitsAhead > 0 ? 'publish' : 'blocked'
  }

  if (hostedReviewCreation.blockedReason === 'needs_push') {
    return 'push'
  }

  if (hostedReviewCreation.blockedReason === 'needs_sync') {
    if (shouldForcePushWithLeaseForUpstream(upstreamStatus)) {
      return 'force_push'
    }
    // Enforce ff-only at execution time to prevent mid-flight divergence or pull.ff=no from silently creating merge commits.
    return isBehindOnlyUpstream(upstreamStatus) ? 'fast_forward' : 'blocked'
  }

  return 'none'
}
