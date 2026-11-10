import type { HostedReviewState } from './source-control/hosted-review/hosted-review-contracts'
import type { CheckStatus } from './github/pull-request-types'

export const REVIEW_REFRESH_COOLDOWN_MS = 10_000
export const CLOSED_REVIEW_REFRESH_INTERVAL_MS = 15 * 60_000

/** How often PR/review state refreshes on a timer. Selecting a worktree, pushing, returning to the
 *  window and manual refresh still read at once in every mode. */
export const PR_AUTO_REFRESH_CADENCES = ['default', 'reduced', 'minimal', 'off'] as const
export type PRAutoRefreshCadence = (typeof PR_AUTO_REFRESH_CADENCES)[number]

const CADENCE_INTERVAL_FACTOR: Record<Exclude<PRAutoRefreshCadence, 'off'>, number> = {
  default: 1,
  reduced: 5,
  minimal: 10
}

function isPRAutoRefreshCadence(value: unknown): value is PRAutoRefreshCadence {
  return PR_AUTO_REFRESH_CADENCES.some((cadence) => cadence === value)
}

export function normalizePRAutoRefreshCadence(value: unknown): PRAutoRefreshCadence {
  return isPRAutoRefreshCadence(value) ? value : 'default'
}

// Why process-wide: every renderer/main caller of the policy must follow the same setting, and each
// process applies its own host's setting once rather than threading it through every scheduler.
let processCadence: PRAutoRefreshCadence = 'default'

export function setPRAutoRefreshCadence(value: unknown): void {
  processCadence = normalizePRAutoRefreshCadence(value)
}

export function getPRAutoRefreshCadence(): PRAutoRefreshCadence {
  return processCadence
}

/** Stretch a timed interval by the cadence; null means no timed refresh. */
export function scaleReviewRefreshInterval(
  intervalMs: number | null,
  cadence: PRAutoRefreshCadence = processCadence
): number | null {
  if (intervalMs === null || cadence === 'off') {
    return null
  }
  return intervalMs * CADENCE_INTERVAL_FACTOR[cadence]
}

function defaultReviewRefreshIntervalMs(input: {
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

export function reviewRefreshIntervalMs(
  input: {
    state?: HostedReviewState | null
    checksStatus?: CheckStatus | null
    hasReview?: boolean | null
    selected?: boolean
  },
  cadence: PRAutoRefreshCadence = processCadence
): number | null {
  return scaleReviewRefreshInterval(defaultReviewRefreshIntervalMs(input), cadence)
}
