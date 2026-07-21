import type { HostedReviewInfo } from '../../../shared/hosted-review'

type SearchableReview = Pick<HostedReviewInfo, 'number' | 'title' | 'provider'>
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

  const titleIndex = review.title.toLowerCase().indexOf(query)
  if (titleIndex === -1) {
    return null
  }
  return {
    labelKind: isMergeRequest ? 'mr' : 'pr',
    text: review.title,
    matchRange: { start: titleIndex, end: titleIndex + query.length }
  }
}
