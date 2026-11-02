import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'

function formatReviewState(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

export function formatHostedReviewLabel(review: {
  provider?: HostedReviewProvider
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
