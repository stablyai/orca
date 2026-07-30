import type { CheckStatus, PRCheckDetail } from './types'

/** Derives the review status from the normalized check contract. */
export function derivePRCheckStatus(checks: readonly PRCheckDetail[]): CheckStatus {
  if (checks.length === 0) {
    return 'neutral'
  }

  let hasPending = false
  let hasSuccess = false
  for (const check of checks) {
    if (
      check.conclusion === 'failure' ||
      check.conclusion === 'timed_out' ||
      check.conclusion === 'cancelled' ||
      check.conclusion === 'action_required'
    ) {
      return 'failure'
    }
    if (
      check.status === 'queued' ||
      check.status === 'in_progress' ||
      check.conclusion === 'pending'
    ) {
      hasPending = true
    }
    if (check.conclusion === 'success') {
      hasSuccess = true
    }
  }

  if (hasPending) {
    return 'pending'
  }
  return hasSuccess ? 'success' : 'neutral'
}
