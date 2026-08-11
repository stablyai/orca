import type { HostedReviewLookupOutcome } from '../../../../shared/hosted-review'
import { isPositiveHostedReviewNumber } from '../../../../shared/hosted-review'

/**
 * Four-state review evidence model for the Checks panel. Replaces the single
 * `hasAmbiguousGitHubHostedReview` Boolean, which collapsed materially different
 * states (missing lookup, failed lookup, positive-but-unrenderable evidence).
 *
 * - `found`: current review details are renderable — leave the empty state.
 * - `positive_unresolved`: a review is known to exist but details are not
 *   renderable. Never offer Create / Push & Create; prefer trusted Open Review.
 * - `not_found`: an accepted no-review result for the exact context.
 * - `unknown`: no accepted positive or no-review result (missing entry, failed
 *   or skipped lookup, in-flight).
 */
export type ChecksPanelReviewLookup = 'found' | 'positive_unresolved' | 'not_found' | 'unknown'

type ReviewLookupNumberLike = number | null | undefined

export type ChecksPanelReviewLookupInput = {
  /**
   * Renderable review details for the exact context (GitHub `PRInfo` payload or
   * equivalent). Treated as renderable only when it carries a usable identity.
   */
  pr: { number?: ReviewLookupNumberLike; url?: string | null } | null | undefined
  /**
   * Tri-state from the PR cache entry: `true` = has PR, `false` = accepted
   * no-PR, `null` = no accepted entry (missing / never fetched). Distinguishes an
   * accepted no-review outcome from a missing lookup.
   */
  prCachedHasPR: boolean | null
  /** Positive hosted-review cache for the exact context, when present. */
  hostedReview:
    | { provider?: string | null; number?: ReviewLookupNumberLike; url?: string | null }
    | null
    | undefined
  /** Durable linked review number for the exact context. */
  linkedReviewNumber?: ReviewLookupNumberLike
  /** Settled eligibility lookup outcome for the exact context. */
  eligibilityReviewLookupOutcome?: HostedReviewLookupOutcome | null
  /** Eligibility review summary (may be summary-only). */
  eligibilityReview?: { number?: ReviewLookupNumberLike; url?: string | null } | null
}

export type ChecksPanelReviewLookupResult = {
  state: ChecksPanelReviewLookup
  /** Trusted http(s) URL for Open Review, when one is known; else null. */
  openReviewUrl: string | null
}

/**
 * Returns the URL only when it is a plain http(s) link with no embedded
 * credentials, so a credential-bearing or non-web value never reaches an Open
 * Review affordance (and never lands in browser history / shell logs).
 */
export function normalizeTrustedReviewUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null
  }
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  // Reject non-web schemes and any userinfo (`user:token@host`) — a prefix regex
  // alone would forward embedded credentials to the browser/shell.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null
  }
  return trimmed
}

/**
 * Review details render the normal review chrome only with a usable identity: a
 * positive review number. A provider-neutral summary without renderable details
 * maps to `positive_unresolved`, not `found`.
 */
export function isRenderableChecksPanelReviewDetails(
  pr: { number?: ReviewLookupNumberLike } | null | undefined
): boolean {
  return pr != null && isPositiveHostedReviewNumber(pr.number)
}

export function resolveChecksPanelReviewLookup(
  input: ChecksPanelReviewLookupInput
): ChecksPanelReviewLookupResult {
  if (isRenderableChecksPanelReviewDetails(input.pr)) {
    return {
      state: 'found',
      openReviewUrl: normalizeTrustedReviewUrl(input.pr?.url)
    }
  }

  // Positive evidence wins over an accepted null no-PR entry: a conflict must
  // stay `positive_unresolved` until a newer accepted result clears it, never
  // collapse to "no PR."
  const openReviewUrl =
    normalizeTrustedReviewUrl(input.hostedReview?.url) ??
    normalizeTrustedReviewUrl(input.eligibilityReview?.url)
  const hasPositiveEvidence =
    isPositiveHostedReviewNumber(input.linkedReviewNumber) ||
    isPositiveHostedReviewNumber(input.hostedReview?.number) ||
    isPositiveHostedReviewNumber(input.eligibilityReview?.number) ||
    input.eligibilityReviewLookupOutcome === 'found' ||
    (input.hostedReview != null && openReviewUrl !== null)
  if (hasPositiveEvidence) {
    return { state: 'positive_unresolved', openReviewUrl }
  }

  if (input.prCachedHasPR === false || input.eligibilityReviewLookupOutcome === 'not_found') {
    return { state: 'not_found', openReviewUrl: null }
  }

  return { state: 'unknown', openReviewUrl: null }
}
