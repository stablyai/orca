import { summarizeProviderChecks, type CheckOutcomeInput } from './provider-check-summary'
import type { PRCheckDetail } from '../../github/check-types'
import type { CheckStatus, ProviderCheckSummary } from '../../github/pull-request-types'

export function derivePRCheckStatus(checks: readonly PRCheckDetail[]): CheckStatus {
  const { state } = summarizeProviderChecks(checks)
  // Why: CheckStatus has no 'none'; an empty rollup carries the same "nothing to report" meaning.
  return state === 'none' ? 'neutral' : state
}

function normalizeRollupCheck(value: unknown): CheckOutcomeInput {
  const raw = value && typeof value === 'object' ? value : {}
  const status = String('status' in raw ? (raw.status ?? '') : '').toLowerCase()
  const state = String('state' in raw ? (raw.state ?? '') : '').toLowerCase()
  const conclusion = String('conclusion' in raw ? (raw.conclusion ?? '') : '').toLowerCase()
  const normalizedConclusion =
    conclusion === 'error' || conclusion === 'startup_failure'
      ? 'failure'
      : conclusion ||
        (state === 'failure' || state === 'error'
          ? 'failure'
          : state === 'success'
            ? 'success'
            : '')
  const observedStatus =
    status || (['success', 'failure', 'error'].includes(state) ? 'completed' : 'queued')
  return {
    status: observedStatus,
    conclusion: normalizedConclusion || null
  }
}

export function summarizePRCheckRollup(rollup: unknown): ProviderCheckSummary {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return summarizeProviderChecks([])
  }
  return summarizeProviderChecks(rollup.map(normalizeRollupCheck))
}

export function derivePRCheckStatusFromRollup(rollup: unknown): CheckStatus {
  const { state } = summarizePRCheckRollup(rollup)
  return state === 'none' ? 'neutral' : state
}
