import type {
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewLookupOutcome
} from '../../../../shared/hosted-review'
import type { PRRefreshErrorType } from '../../../../shared/github/pull-request-refresh-types'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'
import { isHostedReviewCreateEligibilityConfirmable } from '../../../../shared/hosted-review-create-confirmation'
import type { ChecksPanelReviewLookup } from './checks-panel-review-lookup-authority'
// Share hard-error definitions so composer gating and empty-state copy cannot drift.
import { HARD_REFRESH_ERROR_TYPES } from './checks-panel-review-state-model'

export function resolveChecksPanelHostedReviewBaseRef(input: {
  worktreeBaseRef?: string | null
  repoBaseRef?: string | null
}): string | null {
  const worktreeBaseRef = normalizeChecksPanelHostedReviewBaseRef(input.worktreeBaseRef)
  return worktreeBaseRef || normalizeChecksPanelHostedReviewBaseRef(input.repoBaseRef)
}

function normalizeChecksPanelHostedReviewBaseRef(ref: string | null | undefined): string | null {
  const normalizedRef = ref ? normalizeHostedReviewBaseRef(ref) : ''
  return normalizedRef || null
}

const CONFIRMED_ELIGIBILITY_MAX_AGE_MS = 5 * 60_000

export function isChecksPanelHardRefreshErrorType(errorType: string | undefined): boolean {
  return errorType != null && HARD_REFRESH_ERROR_TYPES.has(errorType as PRRefreshErrorType)
}

export type ChecksPanelConfirmedReadiness = {
  confirmed: boolean
  /** The confirmed path is Push & Create rather than plain Create. */
  needsPush: boolean
}

export type ChecksPanelConfirmedReadinessInput = {
  /** The eligibility result's context key equals the panel's current context. */
  contextKeyMatches: boolean
  eligibility: Pick<
    HostedReviewCreationEligibility,
    'canCreate' | 'blockedReason' | 'reviewLookupOutcome'
  > | null
  /** Wall-clock time the eligibility result settled. */
  eligibilityCompletedAt?: number
  /** Wall-clock time the eligibility request that produced the result started. */
  eligibilityRequestStartedAt?: number
  reviewLookup: ChecksPanelReviewLookup
  /** Latest hard-error observation for this context, if any. */
  hardErrorObservedAt?: number
  /** Whether HEAD/branch/upstream/ahead/behind/dirty/base/host still match the eligibility snapshot. */
  gitSnapshotMatches: boolean
  now: number
}

const NOT_CONFIRMED: ChecksPanelConfirmedReadiness = { confirmed: false, needsPush: false }

/** Clear sticky errors only after a newer same-context request accepts found/not_found; in-flight retries cannot reenable Create. */
export function isChecksPanelHardErrorCleared(input: ChecksPanelConfirmedReadinessInput): boolean {
  if (input.hardErrorObservedAt === undefined) {
    return true
  }
  const startedAt = input.eligibilityRequestStartedAt
  if (startedAt === undefined || !(startedAt > input.hardErrorObservedAt)) {
    return false
  }
  if (!input.contextKeyMatches) {
    return false
  }
  const outcome: HostedReviewLookupOutcome | undefined = input.eligibility?.reviewLookupOutcome
  return outcome === 'found' || outcome === 'not_found'
}

/** Drop confirmation on any failed context/freshness check; callers pass only hard-error observations. */
export function computeChecksPanelConfirmedReadiness(
  input: ChecksPanelConfirmedReadinessInput
): ChecksPanelConfirmedReadiness {
  const eligibility = input.eligibility
  if (!input.contextKeyMatches) {
    return NOT_CONFIRMED
  }
  // Fold sticky errors into the shared mobile/desktop hard-block floor.
  if (
    !isHostedReviewCreateEligibilityConfirmable({
      eligibility,
      reviewLookup: input.reviewLookup,
      hasHardRefreshError: !isChecksPanelHardErrorCleared(input)
    })
  ) {
    return NOT_CONFIRMED
  }
  if (
    input.eligibilityCompletedAt === undefined ||
    input.now - input.eligibilityCompletedAt > CONFIRMED_ELIGIBILITY_MAX_AGE_MS ||
    !input.gitSnapshotMatches
  ) {
    return NOT_CONFIRMED
  }
  return { confirmed: true, needsPush: eligibility?.blockedReason === 'needs_push' }
}

export type { HostedReviewCreationBlockedReason }
