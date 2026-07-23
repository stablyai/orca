import type { HostedReviewInfo } from '../../../shared/hosted-review'

// title is intentionally optional: rehydrated review/PR caches can hold entries without one.
type SearchableReview = Pick<HostedReviewInfo, 'number' | 'provider'> & { title?: string }
type WorktreePaletteReviewMatch = {
  labelKind: 'pr' | 'mr'
  text: string
  matchRange: { start: number; end: number }
}

export function matchWorktreePaletteReview(
  review: SearchableReview,
  query: string,
  numericQuery: string
): WorktreePaletteReviewMatch | null {
  const isMergeRequest = review.provider === 'gitlab'
  const numberPrefix = isMergeRequest ? 'MR !' : 'PR #'
  const hasPullRequestSigil = query.startsWith('#')
  const hasMergeRequestSigil = query.startsWith('!')
  const sigilMatchesProvider =
    (!hasPullRequestSigil && !hasMergeRequestSigil) ||
    (hasPullRequestSigil && !isMergeRequest) ||
    (hasMergeRequestSigil && isMergeRequest)
  const reviewNumericQuery = hasMergeRequestSigil ? query.slice(1) : numericQuery
  const reviewNumberIndex = sigilMatchesProvider
    ? String(review.number).indexOf(reviewNumericQuery)
    : -1
  if (reviewNumericQuery && reviewNumberIndex !== -1) {
    return {
      labelKind: isMergeRequest ? 'mr' : 'pr',
      text: `${numberPrefix}${review.number}`,
      matchRange: {
        start: numberPrefix.length + reviewNumberIndex,
        end: numberPrefix.length + reviewNumberIndex + reviewNumericQuery.length
      }
    }
  }

  // Null-safe: a cached review may have no title, so fall back to '' (query is non-empty, so it won't match).
  const title = review.title ?? ''
  const titleIndex = title.toLowerCase().indexOf(query)
  if (titleIndex === -1) {
    return null
  }
  return {
    labelKind: isMergeRequest ? 'mr' : 'pr',
    text: title,
    matchRange: { start: titleIndex, end: titleIndex + query.length }
  }
}
