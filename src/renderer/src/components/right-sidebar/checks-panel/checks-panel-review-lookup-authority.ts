import type { HostedReviewLookupAuthority } from '../../../../../shared/source-control/hosted-review/hosted-review-create-confirmation'
import type { HostedReviewLookupOutcome } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { isPositiveHostedReviewNumber } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/repositories/links'

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
    | {
        provider?: string | null
        number?: ReviewLookupNumberLike
        url?: string | null
        githubRepository?: { owner: string; repo: string; host?: string } | null
      }
    | null
    | undefined
  /** Durable linked review number for the exact context. */
  linkedReviewNumber?: ReviewLookupNumberLike
  /** Settled eligibility lookup outcome for the exact context. */
  eligibilityReviewLookupOutcome?: HostedReviewLookupOutcome | null
  /** Eligibility review summary (may be summary-only). */
  eligibilityReview?: { number?: ReviewLookupNumberLike; url?: string | null } | null
  /** GitHub URLs must name the evidence's PR number (and repository, when known). */
  isGitHub?: boolean
}

export type ChecksPanelReviewLookupResult = {
  state: ChecksPanelReviewLookup
  /** Trusted http(s) URL for Open Review, when one is known; else null. */
  openReviewUrl: string | null
  /** The positive review number the panel names; a durable link outranks lookup hints. */
  reviewNumber?: number | null
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
  const reviewNumber = [
    input.linkedReviewNumber,
    input.hostedReview?.number,
    input.eligibilityReview?.number
  ].find(isPositiveHostedReviewNumber)
  const evidenceUrl = (
    evidence: { number?: ReviewLookupNumberLike; url?: string | null } | null | undefined,
    repository?: { owner: string; repo: string; host?: string } | null,
    provider?: string | null
  ): string | null => {
    const url = normalizeTrustedReviewUrl(evidence?.url)
    // GitHub PR-number/repository checks apply only to GitHub evidence.
    if (!url || !input.isGitHub || (provider != null && provider !== 'github')) {
      return url
    }
    const link = parseGitHubIssueOrPRLink(url)
    const sameRepository =
      !repository ||
      (link?.slug.owner.toLowerCase() === repository.owner.toLowerCase() &&
        link.slug.repo.toLowerCase() === repository.repo.toLowerCase() &&
        (link.slug.host ?? 'github.com').toLowerCase() ===
          (repository.host ?? 'github.com').toLowerCase())
    return link?.type === 'pr' &&
      link.number === evidence?.number &&
      link.number === reviewNumber &&
      sameRepository
      ? url
      : null
  }
  const openReviewUrl =
    evidenceUrl(
      input.hostedReview,
      input.hostedReview?.githubRepository,
      input.hostedReview?.provider
    ) ?? evidenceUrl(input.eligibilityReview)
  const hasPositiveEvidence =
    isPositiveHostedReviewNumber(input.linkedReviewNumber) ||
    isPositiveHostedReviewNumber(input.hostedReview?.number) ||
    isPositiveHostedReviewNumber(input.eligibilityReview?.number) ||
    input.eligibilityReviewLookupOutcome === 'found' ||
    (input.hostedReview != null && openReviewUrl !== null)
  if (hasPositiveEvidence) {
    return { state: 'positive_unresolved', openReviewUrl, reviewNumber: reviewNumber ?? null }
  }

  if (input.prCachedHasPR === false || input.eligibilityReviewLookupOutcome === 'not_found') {
    return { state: 'not_found', openReviewUrl: null }
  }

  return { state: 'unknown', openReviewUrl: null }
}
