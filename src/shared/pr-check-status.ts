import { getProviderCheckStatuses, summarizeProviderChecks } from './provider-check-summary'
import type { ProviderCheckStatuses } from './provider-check-summary'
import type { PRCheckDetail } from './github/check-types'
import type { CheckStatus } from './github/pull-request-types'

export type DerivedPRCheckStatuses = ProviderCheckStatuses

function deriveStatuses(checks: readonly PRCheckDetail[]): DerivedPRCheckStatuses {
  return getProviderCheckStatuses(summarizeProviderChecks(checks))
}

/** Derives the review status from the normalized check contract. */
export function derivePRCheckStatus(checks: readonly PRCheckDetail[]): CheckStatus {
  return deriveStatuses(checks).status
}

export function derivePRCheckStatuses(checks: readonly PRCheckDetail[]): DerivedPRCheckStatuses {
  return deriveStatuses(checks)
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
  return derivePRCheckStatusesFromRollup(rollup).status
}

export function derivePRCheckStatusesFromRollup(rollup: unknown): DerivedPRCheckStatuses {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return { status: 'neutral' }
  }
  return deriveStatuses(
    rollup.map((raw, index) =>
      normalizeRollupCheck(raw && typeof raw === 'object' ? (raw as RawCheckRollup) : {}, index)
    )
  )
}
