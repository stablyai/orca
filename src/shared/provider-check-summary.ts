import type { ProviderCheckSummary } from './github/pull-request-types'

export type CheckOutcome = 'passed' | 'failed' | 'pending' | 'cancelled' | 'neutral'

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
  'action_required'
])

// Why: a cancellation blocks the merge exactly like a failure, but it is not one — the
// user (or a superseding push) stopped the run. It rolls up into its own bucket so
// aggregate surfaces can say "Cancelled" instead of "Failed" (#15847).
const CANCELLED_CONCLUSIONS = new Set(['cancelled'])

/** The single provider-neutral verdict for one check; every check surface must route through it. */
export function classifyCheckOutcome(check: CheckOutcomeInput): CheckOutcome {
  const conclusion = (check.conclusion ?? '').toLowerCase()
  const status = (check.status ?? '').toLowerCase()
  if (FAILED_CONCLUSIONS.has(conclusion)) {
    return 'failed'
  }
  if (CANCELLED_CONCLUSIONS.has(conclusion)) {
    return 'cancelled'
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
  counts: Pick<ProviderCheckSummary, 'total' | 'passed' | 'failed' | 'pending'> &
    Partial<Pick<ProviderCheckSummary, 'cancelled'>>
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
  // Why: cancelled sits below pending — while anything is still running the honest live state is
  // pending — and above passing, because a cancelled set is deliberately not green.
  if ((counts.cancelled ?? 0) > 0) {
    return 'cancelled'
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
  let cancelled = 0
  for (const check of checks) {
    const outcome = classifyCheckOutcome(check)
    if (outcome === 'passed') {
      passed += 1
    } else if (outcome === 'failed') {
      failed += 1
    } else if (outcome === 'pending') {
      pending += 1
    } else if (outcome === 'cancelled') {
      cancelled += 1
    } else {
      neutral += 1
    }
  }
  const total = checks.length
  return {
    state: resolveProviderCheckState({ total, passed, failed, pending, cancelled }),
    total,
    passed,
    failed,
    pending,
    neutral,
    cancelled
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
  if ((summary.cancelled ?? 0) > 0) {
    return `${summary.cancelled} cancelled`
  }
  return summary.state === 'neutral'
    ? 'Unresolved checks'
    : `${summary.passed}/${summary.total} passed`
}
