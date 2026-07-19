import { shouldForcePushWithLeaseForUpstream } from './git-upstream-status'
import type { HostedReviewCreationEligibility } from './hosted-review'
import { supportsHostedReviewCreation } from './hosted-review-creation-providers'
import type { GitUpstreamStatus } from './git-status-types'
import type { SourceControlPrimaryActionDecision } from './source-control-primary-action-decision-types'

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
  hostedReviewCreation?: HostedReviewCreationEligibility | null
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

  // Why: a behind-only branch (no local commits) is safe to prepare with a
  // fast-forward sync, so the intent flow can handle it in one click. A
  // genuinely diverged branch stays ineligible — syncing it would merge
  // without consent, so the user keeps the explicit sync-first step.
  if (
    hostedReviewCreation.blockedReason === 'needs_sync' &&
    upstreamStatus?.hasUpstream === true &&
    upstreamStatus.ahead === 0 &&
    upstreamStatus.behind > 0
  ) {
    return { eligible: true, kind: 'needs_sync' }
  }

  return { eligible: false, kind: null }
}

export function resolveVisibleCreateReviewHeaderAction({
  createPrHeaderAction
}: {
  createPrHeaderAction: SourceControlPrimaryActionDecision | null
}): SourceControlPrimaryActionDecision | null {
  // Why: keep a stable header anchor; disable Create Review when the branch is
  // not ready instead of hiding it and shifting toolbar layout.
  return createPrHeaderAction
}
