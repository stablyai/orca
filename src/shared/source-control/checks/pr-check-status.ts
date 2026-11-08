import {
  classifyCheckOutcome,
  getProviderChecksOutcome,
  summarizeProviderChecks,
  type CheckOutcomeInput
} from './provider-check-summary'
import type { PRCheckDetail } from '../../github/check-types'
import type { CheckStatus, ProviderCheckSummary } from '../../github/pull-request-types'

export function derivePRCheckStatus(checks: readonly PRCheckDetail[]): CheckStatus {
  const { state } = summarizeProviderChecks(checks)
  // Why: CheckStatus has no 'none'; an empty rollup carries the same "nothing to report" meaning.
  return state === 'none' ? 'neutral' : state
}

export function normalizeRollupCheck(value: unknown): CheckOutcomeInput {
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

export type PRCheckRollupResult = {
  final: boolean
  /** Set only when final: cancellation alone, neutral and empty results report nothing. */
  verdict: 'failure' | 'success' | null
  failingCheckNames: string[]
}

function rollupCheckName(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const name = 'name' in value ? value.name : 'context' in value ? value.context : null
  return typeof name === 'string' && name ? name : null
}

/** One normalization decides finality, the verdict and the failing names together. */
export function classifyPRCheckRollupResult(
  rollup: readonly unknown[],
  readComplete: boolean
): PRCheckRollupResult {
  const checks = rollup.map(normalizeRollupCheck)
  const summary = summarizeProviderChecks(checks)
  const failingCheckNames = rollup.flatMap((row, index) => {
    const name = rollupCheckName(row)
    return name && classifyCheckOutcome(checks[index]!) === 'failed' ? [name] : []
  })
  // A suite waiting for approval has not run, so it can neither fail nor pass the head yet.
  const awaitingApproval = rollup.some(
    (row) => !!row && typeof row === 'object' && 'pendingApproval' in row && row.pendingApproval
  )
  const final = readComplete && summary.total > 0 && summary.pending === 0 && !awaitingApproval
  const outcome = final ? getProviderChecksOutcome(summary) : null
  return {
    final,
    verdict: outcome === 'failure' || outcome === 'success' ? outcome : null,
    failingCheckNames
  }
}
