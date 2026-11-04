import type { ProviderCheckSummary } from '../../../../shared/github/pull-request-types'
import { getProviderChecksOutcome } from '../../../../shared/provider-check-summary'
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
  checksSummary?: ProviderCheckSummary
}): string {
  const { shortLabel } = localizedHostedReviewCopy(
    resolveSupportedHostedReviewCopyProvider(review.provider)
  )
  const symbol = review.provider === 'gitlab' ? '!' : '#'
  const status =
    review.status === 'failure' ||
    review.status === 'pending' ||
    review.status === 'success' ||
    review.status === 'neutral'
      ? getProviderChecksOutcome(review.checksSummary, review.status)
      : review.status
  const statusSuffix = status && status !== 'none' ? `, ${status}` : ''
  return `${shortLabel} ${symbol}${review.number} ${formatReviewState(review.state)}${statusSuffix}`
}
