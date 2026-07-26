import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'

export function formatReviewState(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

// Why: a hosted review is not always a GitHub PR — GitLab uses "MR !5", not
// "PR #5". Use the provider-aware copy/symbol the rest of the app already uses.
export function formatHostedReviewLabel(review: {
  provider: HostedReviewProvider
  number: number
  state: string
  status: string
}): string {
  const { shortLabel } = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(review.provider)
  )
  const symbol = review.provider === 'gitlab' ? '!' : '#'
  const statusSuffix = review.status && review.status !== 'none' ? `, ${review.status}` : ''
  return `${shortLabel} ${symbol}${review.number} ${formatReviewState(review.state)}${statusSuffix}`
}
