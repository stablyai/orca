import type {
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewLookupOutcome
} from '../../../../shared/hosted-review'
import type { PRRefreshErrorType } from '../../../../shared/github/pull-request-refresh-types'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'
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

/** Share desktop/mobile create blockers; unproven review absence fails closed, with desktop freshness checks layered on top. */
export function isChecksPanelCreateEligibilityConfirmable(input: {
  eligibility: Pick<
    HostedReviewCreationEligibility,
    'canCreate' | 'blockedReason' | 'reviewLookupOutcome'
  > | null
  reviewLookup: ChecksPanelReviewLookup
  hasHardRefreshError: boolean
}): boolean {
  const eligibility = input.eligibility
  if (!eligibility || eligibility.blockedReason === 'existing_review') {
    return false
  }
  if (input.reviewLookup === 'positive_unresolved' || input.hasHardRefreshError) {
    return false
  }
  // Unavailable lookup may hide a real review; block needs_push as well as plain Create.
  if (eligibility.reviewLookupOutcome === 'unavailable') {
    return false
  }
  return eligibility.canCreate === true || eligibility.blockedReason === 'needs_push'
}

/** Open only a confirmed composer through the shared desktop/mobile hard-block gate. */
export function shouldOpenChecksPanelCreateComposer(input: {
  activeReview: unknown
  isFolder: boolean
  branch: string
  hostedReviewCreation: HostedReviewCreationEligibility | null
  reviewLookup?: ChecksPanelReviewLookup
  hasHardRefreshError?: boolean
}): boolean {
  if (input.activeReview || input.isFolder || !input.branch) {
    return false
  }
  return isChecksPanelCreateEligibilityConfirmable({
    eligibility: input.hostedReviewCreation,
    reviewLookup: input.reviewLookup ?? 'unknown',
    hasHardRefreshError: input.hasHardRefreshError === true
  })
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
    !isChecksPanelCreateEligibilityConfirmable({
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
