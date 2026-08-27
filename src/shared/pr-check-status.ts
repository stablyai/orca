import { summarizeProviderChecks } from './provider-check-summary'
import type { PRCheckDetail } from './github/check-types'
import type { CheckStatus } from './github/pull-request-types'

/** Derives the review status from the normalized check contract. */
export function derivePRCheckStatus(checks: readonly PRCheckDetail[]): CheckStatus {
  const { state } = summarizeProviderChecks(checks)
  // Why: CheckStatus has no 'none'; an empty rollup carries the same "nothing to report" meaning.
  return state === 'none' ? 'neutral' : state
}

type RawCheckRollup = { status?: unknown; conclusion?: unknown; state?: unknown }

function normalizeRollupCheck(raw: RawCheckRollup, index: number): PRCheckDetail {
  const status = String(raw.status ?? '').toLowerCase()
  const state = String(raw.state ?? '').toLowerCase()
  const conclusion = String(raw.conclusion ?? '').toLowerCase()
  const normalizedConclusion =
    conclusion === 'error' || conclusion === 'startup_failure'
      ? 'failure'
      : conclusion ||
        (state === 'failure' || state === 'error'
          ? 'failure'
          : state === 'success'
            ? 'success'
            : '')
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
