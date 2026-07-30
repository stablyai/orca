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

type RawCheckRollup = { status?: unknown; conclusion?: unknown; state?: unknown }

function normalizeRollupCheck(raw: RawCheckRollup, index: number): PRCheckDetail {
  const status = String(raw.status ?? '').toLowerCase()
  const state = String(raw.state ?? '').toLowerCase()
  const conclusion = String(raw.conclusion ?? '').toLowerCase()
  const normalizedConclusion =
    conclusion ||
    (state === 'failure' || state === 'error' ? 'failure' : state === 'success' ? 'success' : '')
  const isPending =
    status === 'queued' ||
    status === 'in_progress' ||
    status === 'pending' ||
    state === 'pending' ||
    conclusion === 'pending'

  return {
    name: `check-${index}`,
    status: isPending ? (status === 'in_progress' ? 'in_progress' : 'queued') : 'completed',
    conclusion: (isPending
      ? 'pending'
      : normalizedConclusion || null) as PRCheckDetail['conclusion'],
    url: null
  }
}

/** Derives status from provider rollups while retaining status/conclusion semantics. */
export function derivePRCheckStatusFromRollup(rollup: unknown): CheckStatus {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return 'neutral'
  }
  return derivePRCheckStatus(
    rollup.map((raw, index) =>
      normalizeRollupCheck(raw && typeof raw === 'object' ? (raw as RawCheckRollup) : {}, index)
    )
  )
}
