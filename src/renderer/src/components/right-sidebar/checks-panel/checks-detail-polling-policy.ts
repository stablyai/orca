import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { CheckStatus } from '../../../../../shared/github/pull-request-types'
import type { HostedReviewState } from '../../../../../shared/hosted-review'
import { reviewRefreshIntervalMs } from '../../../../../shared/review-refresh-policy'

export function detailedChecksStatus(checks: readonly PRCheckDetail[]): CheckStatus | undefined {
  if (checks.length === 0) {
    return undefined
  }
  if (
    checks.some(
      (check) =>
        check.status !== 'completed' ||
        check.conclusion === 'pending' ||
        check.conclusion === 'action_required' ||
        check.conclusion === null
    )
  ) {
    return 'pending'
  }
  if (
    checks.some((check) => ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? ''))
  ) {
    return 'failure'
  }
  return checks.some((check) => check.conclusion === 'success') ? 'success' : 'neutral'
}

export class ChecksDetailPollingPolicy {
  private status: CheckStatus | undefined
  private hasDetails = false
  private failed = false

  reset(): void {
    this.status = undefined
    this.hasDetails = false
    this.failed = false
  }

  accept(checks: readonly PRCheckDetail[]): string {
    this.status = detailedChecksStatus(checks)
    this.hasDetails = true
    this.failed = false
    return JSON.stringify(
      checks.map((check) => `${check.name}:${check.status}:${check.conclusion}`)
    )
  }

  fail(): void {
    this.failed = true
  }

  delayMs(
    state: HostedReviewState | undefined,
    aggregateStatus: CheckStatus | undefined,
    backoffMs: number
  ): number | null {
    if (this.failed) {
      return Math.max(state === 'closed' ? 900_000 : 60_000, backoffMs)
    }
    const status = this.hasDetails && this.status !== undefined ? this.status : aggregateStatus
    const interval = reviewRefreshIntervalMs({
      state,
      checksStatus: status,
      hasReview: true,
      selected: true
    })
    if (interval === null) {
      return null
    }
    return state === 'closed' ? interval : Math.max(interval, backoffMs)
  }
}
