import { normalizePRCheckHeadSha } from '../../../shared/github/checks/pr-check-head'
import {
  isCompletePRCheckOwner,
  samePRCheckObservation
} from '../../../shared/github/checks/complete-pr-check-owner'
import type { ProviderCheckSummary } from '../../../shared/github/pull-requests/pull-request-types'
import { translate } from '../i18n/i18n'
import type { Translate } from '../i18n/use-translate'
import { summarizeProviderChecks } from '../../../shared/source-control/checks/provider-check-summary'
import type { PRCheckDetail } from '../../../shared/github/checks/check-types'

export type PRCheckCounts = {
  passing: number
  failing: number
  cancelled: number
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
    failing: summary.failed - needsAction - (summary.cancelled ?? 0),
    cancelled: summary.cancelled ?? 0,
    needsAction,
    pending: summary.pending,
    neutral: summary.neutral
  }
}

export function getOverallCheckCounts(
  checks: readonly PRCheckDetail[],
  owner?: { headSha?: string; checksSummary?: ProviderCheckSummary },
  rowsOwner?: { checksSummary?: ProviderCheckSummary }
): PRCheckCounts {
  if (!owner || !isCompletePRCheckOwner(owner)) {
    return getCheckCounts(checks)
  }
  const summary = owner.checksSummary
  const failed = (summary?.failed ?? 0) - (summary?.cancelled ?? 0)
  const rows = getCheckCounts(checks)
  const distinctApprovals = new Set(
    checks
      .filter((check) => getCheckConclusion(check) === 'action_required')
      .map((check) => check.checkRunId ?? check.workflowRunId ?? check.url ?? check.name)
  ).size
  const explained =
    rowsOwner &&
    samePRCheckObservation(owner, rowsOwner) &&
    checks.length > 0 &&
    checks.every(
      (check) =>
        normalizePRCheckHeadSha(check.observedHeadSha) !== undefined &&
        normalizePRCheckHeadSha(check.observedHeadSha) === normalizePRCheckHeadSha(owner.headSha)
    ) &&
    failed > 0 &&
    distinctApprovals === failed &&
    rows.needsAction === distinctApprovals &&
    rows.failing === 0
  return {
    passing: summary?.passed ?? 0,
    failing: explained ? 0 : failed,
    cancelled: summary?.cancelled ?? 0,
    needsAction: explained ? failed : 0,
    pending: summary?.pending ?? 0,
    neutral: summary?.neutral ?? 0
  }
}

/** `tone` keys the caller's `CHECK_COLOR`/`CHECK_ICON` maps so styling stays with the surface. */
export type PRCheckCountChip = {
  tone: 'success' | 'failure' | 'cancelled' | 'action_required' | 'pending' | 'neutral'
  label: string
}

/** Share count-chip wording so neutral checks read unresolved consistently across surfaces. */
export function getCheckCountChips(
  counts: PRCheckCounts,
  t: Translate = translate
): PRCheckCountChip[] {
  const chips: PRCheckCountChip[] = []
  if (counts.passing > 0) {
    chips.push({
      tone: 'success',
      label: t('auto.components.pr-check-counts.passingChip', '{{value0}} passing', {
        value0: counts.passing
      })
    })
  }
  if (counts.failing > 0) {
    chips.push({
      tone: 'failure',
      label: t('auto.components.pr-check-counts.failingChip', '{{value0}} failing', {
        value0: counts.failing
      })
    })
  }
  if (counts.cancelled > 0) {
    chips.push({
      tone: 'cancelled',
      label: `${counts.cancelled} ${t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')}`
    })
  }
  if (counts.needsAction > 0) {
    chips.push({
      tone: 'action_required',
      label: t('auto.components.pr-check-counts.needsActionChip', '{{value0}} action required', {
        value0: counts.needsAction
      })
    })
  }
  if (counts.pending > 0) {
    chips.push({
      tone: 'pending',
      label: t('auto.components.pr-check-counts.pendingChip', '{{value0}} pending', {
        value0: counts.pending
      })
    })
  }
  if (counts.neutral > 0) {
    chips.push({
      tone: 'neutral',
      label: t('auto.components.pr-check-counts.unresolvedChip', '{{value0}} unresolved', {
        value0: counts.neutral
      })
    })
  }
  return chips
}

export function getChecksSummaryLabel(
  checks: readonly PRCheckDetail[],
  owner?: { headSha?: string; checksSummary?: ProviderCheckSummary },
  rowsOwner?: { checksSummary?: ProviderCheckSummary },
  t: Translate = translate
): string {
  const complete = owner && isCompletePRCheckOwner(owner)
  if (complete && !owner.checksSummary) {
    return t('auto.components.right.sidebar.ChecksPanel.976cefd02f', 'Checks unavailable')
  }
  const total = complete ? owner.checksSummary!.total : checks.length
  const counts = getOverallCheckCounts(checks, owner, rowsOwner)
  if (total === 0) {
    return t('auto.components.prCheckCounts.noChecksFound', 'No checks found')
  }
  if (counts.failing > 0) {
    return t('auto.components.prCheckCounts.checksFailing', '{{count}} checks failing', {
      count: counts.failing,
      defaultValue_one: '{{count}} check failing'
    })
  }
  // Why: action_required (e.g. workflow awaiting approval) blocks merge but isn't a failure, so surface it distinctly.
  if (counts.needsAction > 0) {
    return t('auto.components.prCheckCounts.checksNeedAction', '{{count}} checks need action', {
      count: counts.needsAction,
      defaultValue_one: '{{count}} check needs action'
    })
  }
  if (counts.pending > 0) {
    return t('auto.components.prCheckCounts.checksPending', '{{count}} checks pending', {
      count: counts.pending,
      defaultValue_one: '{{count}} check pending'
    })
  }
  if (counts.cancelled > 0) {
    return t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
  }
  if (counts.passing === total) {
    return t('auto.components.prCheckCounts.allChecksPassing', 'All checks passing')
  }
  return t(
    'auto.components.prCheckCounts.checksPassingOfTotal',
    '{{passing}} of {{count}} checks passing',
    {
      count: total,
      passing: counts.passing,
      defaultValue_one: '{{passing}} of {{count}} check passing'
    }
  )
}
