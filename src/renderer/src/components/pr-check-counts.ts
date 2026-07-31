import { classifyCheckOutcome } from '../../../shared/provider-check-summary'
import type { PRCheckDetail } from '../../../shared/types'

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

/**
 * The check-tab breakdown shared by the PR page and the work-item dialog. Both panes used to keep
 * private copies, which is how one drifted from the Checks panel's own header.
 */
export function getCheckCounts(checks: readonly PRCheckDetail[]): PRCheckCounts {
  return checks.reduce<PRCheckCounts>(
    (counts, check) => {
      const conclusion = getCheckConclusion(check)
      // Why: the shared classifier counts a skipped check as passing, so bucketing it separately
      // made this pane say "2 passing" for the same list the Checks panel called "5 passing".
      // action_required stays its own bucket: it blocks merge but is not a red failure.
      if (classifyCheckOutcome(check) === 'passed') {
        counts.passing += 1
      } else if (conclusion === 'action_required') {
        counts.needsAction += 1
      } else if (['failure', 'cancelled', 'timed_out'].includes(conclusion)) {
        counts.failing += 1
      } else if (conclusion === 'neutral') {
        counts.neutral += 1
      } else {
        counts.pending += 1
      }
      return counts
    },
    { passing: 0, failing: 0, needsAction: 0, pending: 0, neutral: 0 }
  )
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
