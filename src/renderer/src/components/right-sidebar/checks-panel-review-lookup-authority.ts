import type { HostedReviewLookupAuthority } from '../../../../shared/hosted-review-create-confirmation'
import type { HostedReviewLookupOutcome } from '../../../../shared/hosted-review'
import { isPositiveHostedReviewNumber } from '../../../../shared/hosted-review'

/** Separate renderable reviews, positive-unresolved evidence, accepted absence, and unknown lookups; only accepted absence permits create. */
export type ChecksPanelReviewLookup = HostedReviewLookupAuthority

type ReviewLookupNumberLike = number | null | undefined

export type ChecksPanelReviewLookupInput = {
  /** Exact-context review details; a usable identity is required to render. */
  pr: { number?: ReviewLookupNumberLike; url?: string | null } | null | undefined
  /** True means PR; false means accepted absence; null means no accepted cache entry. */
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

/** Allow only credential-free HTTP(S) URLs to keep credentials out of browser history and shell logs. */
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
  // Parse schemes/userinfo; a prefix regex alone would forward embedded credentials.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null
  }
  return trimmed
}

/** Require a positive number to render review details; summary-only evidence remains positive_unresolved. */
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

  // Positive evidence overrides cached absence until a newer accepted result resolves the conflict.
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
