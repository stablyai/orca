import type {
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewLookupOutcome
} from '../../../../shared/hosted-review'
import type { PRRefreshErrorType } from '../../../../shared/types'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'
import type { ChecksPanelReviewLookup } from './checks-panel-review-lookup-authority'
// Single source of truth for the hard-refresh error set, shared with the
// review-state model so the composer gate and empty-state selector cannot drift.
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

/**
 * Shared create-eligibility floor for the desktop confirmed gate and the
 * mobile-shared composer gate. Create / Push & Create is impossible when review
 * existence cannot be proven no-review: positive unresolved evidence, a current
 * hard refresh error, `existing_review`, or an `unavailable` existing-review
 * lookup all fail closed. Otherwise it allows the `canCreate` / `needs_push`
 * paths. Both callers route through this so their hard-block semantics cannot
 * drift; the desktop confirmed gate layers freshness/context checks on top.
 */
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
  // An `unavailable` existing-review lookup could be hiding a real PR. Block even
  // the Push & Create (needs_push) path, which would otherwise slip through the
  // canCreate check below with review existence unproven.
  if (eligibility.reviewLookupOutcome === 'unavailable') {
    return false
  }
  return eligibility.canCreate === true || eligibility.blockedReason === 'needs_push'
}

/**
 * Confirmed-only composer gate shared with mobile. Delegates the hard-block
 * decision to {@link isChecksPanelCreateEligibilityConfirmable} so the desktop
 * confirmed gate and this mobile-shared gate cannot drift. Phase 1 adds no
 * provisional or draft-preserve path.
 */
export function shouldOpenChecksPanelCreateComposer(input: {
  activeReview: unknown | null
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
  /**
   * Observation time of the most recent hard refresh error for this context, or
   * undefined when no hard error is current.
   */
  hardErrorObservedAt?: number
  /**
   * Whether the Git snapshot used for the eligibility still matches current HEAD,
   * branch, upstream/ahead/behind/dirty, base, and execution-host fields.
   */
  gitSnapshotMatches: boolean
  now: number
}

const NOT_CONFIRMED: ChecksPanelConfirmedReadiness = { confirmed: false, needsPush: false }

/**
 * A hard error is cleared only by an eligibility request that started strictly
 * after the error was observed, completed for the same exact context with a
 * `found` / `not_found` lookup outcome, with no newer hard error since. A late
 * `unavailable` fallback or an already-in-flight request cannot clear it.
 *
 * Exported so the panel can keep the hard-error block sticky across
 * `queued` / `in-flight` auto-retries (which drop `status: 'error'` and would
 * otherwise let Create flap back) until this predicate says it is cleared.
 */
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

/**
 * Confirmed readiness for the exact context. Any failed check drops confirmed
 * immediately; transient refresh failures never appear here (the caller only
 * passes a hard error observation, never a transient one).
 */
export function computeChecksPanelConfirmedReadiness(
  input: ChecksPanelConfirmedReadinessInput
): ChecksPanelConfirmedReadiness {
  const eligibility = input.eligibility
  if (!input.contextKeyMatches) {
    return NOT_CONFIRMED
  }
  // Share the hard-block floor with the mobile-shared gate; an uncleared hard
  // error is folded in as the `hasHardRefreshError` input so the two cannot drift.
  if (
    !isChecksPanelCreateEligibilityConfirmable({
      eligibility,
      reviewLookup: input.reviewLookup,
      hasHardRefreshError: !isChecksPanelHardErrorCleared(input)
    })
  ) {
    return NOT_CONFIRMED
  }
  // Freshness: eligibility must be recent and its Git snapshot must still match.
  if (
    input.eligibilityCompletedAt === undefined ||
    input.now - input.eligibilityCompletedAt > CONFIRMED_ELIGIBILITY_MAX_AGE_MS ||
    !input.gitSnapshotMatches
  ) {
    return NOT_CONFIRMED
  }
  return { confirmed: true, needsPush: eligibility?.blockedReason === 'needs_push' }
}

// Re-exported for callers that need the blocker type alongside the gate.
export type { HostedReviewCreationBlockedReason }
