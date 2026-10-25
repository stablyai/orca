import { translate } from '../i18n/i18n'
import { summarizeProviderChecks } from '../../../shared/provider-check-summary'
import type { PRCheckDetail } from '../../../shared/github/check-types'

export type PRCheckCounts = {
  passing: number
  failing: number
  needsAction: number
  pending: number
  neutral: number
}

export function getCheckConclusion(check: PRCheckDetail): NonNullable<PRCheckDetail['conclusion']> {
  if (check.conclusion) {
    return check.conclusion
  }
  return check.status === 'completed' ? 'neutral' : 'pending'
}

/** Use one check breakdown across PR page/dialog and the sidebar header. */
export function getCheckCounts(checks: readonly PRCheckDetail[]): PRCheckCounts {
  // Use the shared rollup; split action_required back out because it blocks like failure but reads amber.
  const summary = summarizeProviderChecks(checks)
  const needsAction = checks.filter(
    (check) => getCheckConclusion(check) === 'action_required'
  ).length
  return {
    passing: summary.passed,
    failing: summary.failed - needsAction,
    needsAction,
    pending: summary.pending,
    neutral: summary.neutral
  }
}

/** `tone` keys the caller's `CHECK_COLOR`/`CHECK_ICON` maps so styling stays with the surface. */
export type PRCheckCountChip = {
  tone: 'success' | 'failure' | 'action_required' | 'pending' | 'neutral'
  label: string
}

/** Share count-chip wording so neutral checks read unresolved consistently across surfaces. */
export function getCheckCountChips(counts: PRCheckCounts): PRCheckCountChip[] {
  const chips: PRCheckCountChip[] = []
  if (counts.passing > 0) {
    chips.push({
      tone: 'success',
      label: translate('auto.components.pr-check-counts.passingChip', '{{value0}} passing', {
        value0: counts.passing
      })
    })
  }
  if (counts.failing > 0) {
    chips.push({
      tone: 'failure',
      label: translate('auto.components.pr-check-counts.failingChip', '{{value0}} failing', {
        value0: counts.failing
      })
    })
  }
  if (counts.needsAction > 0) {
    chips.push({
      tone: 'action_required',
      label: translate(
        'auto.components.pr-check-counts.needsActionChip',
        '{{value0}} action required',
        { value0: counts.needsAction }
      )
    })
  }
  if (counts.pending > 0) {
    chips.push({
      tone: 'pending',
      label: translate('auto.components.pr-check-counts.pendingChip', '{{value0}} pending', {
        value0: counts.pending
      })
    })
  }
  if (counts.neutral > 0) {
    chips.push({
      tone: 'neutral',
      label: translate('auto.components.pr-check-counts.unresolvedChip', '{{value0}} unresolved', {
        value0: counts.neutral
      })
    })
  }
  return chips
}

export function getChecksSummaryLabel(checks: readonly PRCheckDetail[]): string {
  const counts = getCheckCounts(checks)
  if (checks.length === 0) {
    return 'No checks found'
  }
  if (counts.failing > 0) {
    return `${counts.failing} ${counts.failing === 1 ? 'check' : 'checks'} failing`
  }
  // Why: action_required (e.g. workflow awaiting approval) blocks merge but isn't a failure, so surface it distinctly.
  if (counts.needsAction > 0) {
    return `${counts.needsAction} ${counts.needsAction === 1 ? 'check needs' : 'checks need'} action`
  }
  if (counts.pending > 0) {
    return `${counts.pending} ${counts.pending === 1 ? 'check' : 'checks'} pending`
  }
  if (counts.passing === checks.length) {
    return 'All checks passing'
  }
  return `${counts.passing} of ${checks.length} checks passing`
}
