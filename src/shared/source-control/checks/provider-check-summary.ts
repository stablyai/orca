import type { CheckStatus, ProviderCheckSummary } from '../../github/pull-request-types'

export type CheckOutcome = 'passed' | 'failed' | 'pending' | 'neutral'

export type CheckOutcomeInput = { status?: string | null; conclusion?: string | null }

// Skipped means not applicable; count it passing everywhere so desktop/mobile agree on the same PR.
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
  let cancelled = 0
  let pending = 0
  let neutral = 0
  for (const check of checks) {
    const outcome = classifyCheckOutcome(check)
    if (outcome === 'passed') {
      passed += 1
    } else if (outcome === 'failed') {
      failed += 1
      if (check.conclusion?.toLowerCase() === 'cancelled') {
        cancelled += 1
      }
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
    cancelled,
    pending,
    neutral
  }
}

export type CheckPresentationOutcome = ProviderCheckSummary['state'] | 'cancelled' | 'unknown'

type PresentationSummary = Omit<ProviderCheckSummary, 'state'> & {
  state: CheckPresentationOutcome
  unknown?: number
}

/** Only a complete, consistent breakdown can subtract cancellations from legacy failures. */
export function getCancelledCheckCount(summary: PresentationSummary): number | undefined {
  const counts = [
    summary.total,
    summary.passed,
    summary.failed,
    summary.pending,
    summary.neutral,
    summary.cancelled
  ]
  if (
    !counts.every(
      (count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ) ||
    summary.total !==
      summary.passed +
        summary.failed +
        summary.pending +
        summary.neutral +
        (summary.unknown ?? 0) ||
    (summary.state === 'failure' && summary.failed === 0) ||
    (summary.cancelled ?? Infinity) > summary.failed ||
    summary.scope !== undefined
  ) {
    return undefined
  }
  return summary.cancelled
}

export function getProviderChecksOutcome(
  summary: ProviderCheckSummary
): ProviderCheckSummary['state'] | 'cancelled'
export function getProviderChecksOutcome(
  summary: PresentationSummary | undefined,
  fallback: CheckStatus
): CheckStatus | 'cancelled'
export function getProviderChecksOutcome(
  summary: PresentationSummary | undefined,
  fallback?: CheckStatus
): CheckPresentationOutcome | undefined
export function getProviderChecksOutcome(
  summary: PresentationSummary | undefined,
  fallback?: ProviderCheckSummary['state']
): CheckPresentationOutcome | undefined {
  const state = fallback ?? summary?.state
  if (
    !summary ||
    (fallback !== undefined &&
      summary.state !== fallback &&
      !(summary.state === 'none' && fallback === 'neutral'))
  ) {
    return state
  }
  const cancelled = getCancelledCheckCount(summary)
  if (cancelled === undefined || state === 'unknown') {
    return state
  }
  if (summary.failed > cancelled) {
    return 'failure'
  }
  if (summary.pending > 0) {
    return 'pending'
  }
  if (cancelled > 0 && state === 'failure') {
    return 'cancelled'
  }
  return state
}

const PIPELINE_CHECKS_LABEL: Record<ProviderCheckSummary['state'], string> = {
  success: 'Pipeline passed',
  failure: 'Pipeline failed',
  pending: 'Pipeline pending',
  neutral: 'Pipeline unresolved',
  none: 'No checks'
}

/** The one checks-pill label; it keys off `state` so the text can never contradict the pill's tone or icon. */
export function getProviderChecksLabel(summary: ProviderCheckSummary | undefined): string {
  if (!summary) {
    return 'Checks'
  }
  if (summary.scope === 'pipeline') {
    return PIPELINE_CHECKS_LABEL[summary.state]
  }
  if (summary.total === 0) {
    return 'No checks'
  }
  const outcome = getProviderChecksOutcome(summary)
  if (outcome === 'failure') {
    return `${summary.failed - (getCancelledCheckCount(summary) ?? 0)} failing`
  }
  if (outcome === 'pending') {
    return `${summary.pending} pending`
  }
  if (outcome === 'cancelled') {
    return 'Cancelled'
  }
  return summary.state === 'neutral'
    ? 'Unresolved checks'
    : `${summary.passed}/${summary.total} passed`
}
