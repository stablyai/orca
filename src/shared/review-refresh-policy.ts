import type { HostedReviewState } from './hosted-review'
import type { CheckStatus } from './github/pull-request-types'

export const REVIEW_REFRESH_COOLDOWN_MS = 10_000
export const CLOSED_REVIEW_REFRESH_INTERVAL_MS = 15 * 60_000

export function reviewRefreshIntervalMs(input: {
  state?: HostedReviewState | null
  checksStatus?: CheckStatus | null
  hasReview?: boolean | null
  selected?: boolean
}): number | null {
  if (input.hasReview === false) {
    return input.selected ? 60_000 : 15 * 60_000
  }
  if (input.state === 'merged') {
    // Neutral means completed checks or no checks in the hosted-review contract.
    return input.checksStatus == null || input.checksStatus === 'pending' ? 60_000 : null
  }
  if (input.state === 'closed') {
    return CLOSED_REVIEW_REFRESH_INTERVAL_MS
  }
  return input.selected ? 60_000 : 120_000
}

export function finishedReviewRefreshIntervalMs(
  state: HostedReviewState | null | undefined,
  status: CheckStatus | null | undefined
): number | null {
  return state === 'merged' || state === 'closed'
    ? reviewRefreshIntervalMs({ state, checksStatus: status })
    : null
}
