import type { ProviderCheckSummary } from './github/pull-request-types'

export type CheckOutcome = 'passed' | 'failed' | 'pending' | 'neutral'

export type CheckOutcomeInput = { status?: string | null; conclusion?: string | null }

// Why: a skipped job is a deliberate "not applicable", not an unresolved signal — every surface
// must count it as passing or the same PR reads green on desktop and grey on mobile.
const PASSED_CONCLUSIONS = new Set(['success', 'skipped'])

// Why: these block the merge. GitLab `manual` is deliberately absent — it waits on a human.
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'error',
  'startup_failure',
  'timed_out',
  'cancelled',
  'action_required'
])

/** The single provider-neutral verdict for one check; every check surface must route through it. */
export function classifyCheckOutcome(check: CheckOutcomeInput): CheckOutcome {
  const conclusion = (check.conclusion ?? '').toLowerCase()
  const status = (check.status ?? '').toLowerCase()
  if (FAILED_CONCLUSIONS.has(conclusion)) {
    return 'failed'
  }
  if (PASSED_CONCLUSIONS.has(conclusion)) {
    return 'passed'
  }
  // Why: anything that has not reached a terminal status is still running, whatever it calls itself.
  if (conclusion === 'pending' || status !== 'completed') {
    return 'pending'
  }
  return 'neutral'
}

/** Rolls up counted outcomes; passing checks win over neutral ones so one neutral cannot demote a green PR. */
export function resolveProviderCheckState(
  counts: Pick<ProviderCheckSummary, 'total' | 'passed' | 'failed' | 'pending'>
): ProviderCheckSummary['state'] {
  if (counts.total === 0) {
    return 'none'
  }
  if (counts.failed > 0) {
    return 'failure'
  }
  if (counts.pending > 0) {
    return 'pending'
  }
  return counts.passed > 0 ? 'success' : 'neutral'
}

export function summarizeProviderChecks(
  checks: readonly CheckOutcomeInput[]
): ProviderCheckSummary {
  let passed = 0
  let failed = 0
  let pending = 0
  let neutral = 0
  for (const check of checks) {
    const outcome = classifyCheckOutcome(check)
    if (outcome === 'passed') {
      passed += 1
    } else if (outcome === 'failed') {
      failed += 1
    } else if (outcome === 'pending') {
      pending += 1
    } else {
      neutral += 1
    }
  }
  const total = checks.length
  return {
    state: resolveProviderCheckState({ total, passed, failed, pending }),
    total,
    passed,
    failed,
    pending,
    neutral
  }
}

/** The one checks-pill label; it keys off `state` so the text can never contradict the pill's tone or icon. */
export function getProviderChecksLabel(summary: ProviderCheckSummary | undefined): string {
  if (!summary) {
    return 'Checks'
  }
  if (summary.total === 0) {
    return 'No checks'
  }
  if (summary.failed > 0) {
    return `${summary.failed} failing`
  }
  if (summary.pending > 0) {
    return `${summary.pending} pending`
  }
  return summary.state === 'neutral'
    ? 'Unresolved checks'
    : `${summary.passed}/${summary.total} passed`
}
