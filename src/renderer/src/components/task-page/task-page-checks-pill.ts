import { translate } from '@/i18n/i18n'
import {
  getCancelledCheckCount,
  getProviderChecksOutcome
} from '../../../../shared/source-control/checks/provider-check-summary'
import type { ProviderCheckSummary } from '../../../../shared/github/pull-request-types'

type ChecksPillItem = { checksSummary?: ProviderCheckSummary }

function getPipelineChecksLabel(state: ProviderCheckSummary['state']): string {
  switch (state) {
    case 'success':
      return translate('auto.components.task-page.checksPill.pipelinePassed', 'Pipeline passed')
    case 'failure':
      return translate('auto.components.task-page.checksPill.pipelineFailed', 'Pipeline failed')
    case 'pending':
      return translate('auto.components.task-page.checksPill.pipelinePending', 'Pipeline pending')
    case 'neutral':
      return translate(
        'auto.components.task-page.checksPill.pipelineUnresolved',
        'Pipeline unresolved'
      )
    case 'none':
      return translate('auto.components.pr-check-counts.noChecks', 'No checks found')
  }
}

/** Derive label and tone from the same summary so neutral checks cannot contradict a successful state. */
export function getChecksLabel(item: ChecksPillItem): string {
  const summary = item.checksSummary
  if (!summary) {
    return translate('auto.components.TaskPage.a7396b05c6', 'Checks')
  }
  if (summary.scope === 'pipeline') {
    return getPipelineChecksLabel(summary.state)
  }
  if (summary.total === 0) {
    return translate('auto.components.pr-check-counts.noChecks', 'No checks found')
  }
  const outcome = getProviderChecksOutcome(summary)
  if (outcome === 'failure') {
    return translate('auto.components.pr-check-counts.failingChip', '{{value0}} failing', {
      value0: summary.failed - (getCancelledCheckCount(summary) ?? 0)
    })
  }
  if (outcome === 'pending') {
    return translate('auto.components.pr-check-counts.pendingChip', '{{value0}} pending', {
      value0: summary.pending
    })
  }
  if (outcome === 'cancelled') {
    return translate('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
  }
  if (summary.state === 'neutral') {
    return translate('auto.components.pr-check-counts.unresolvedChip', '{{value0}} unresolved', {
      value0: summary.neutral || summary.total
    })
  }
  return translate(
    'auto.components.pr-check-counts.passingSummary',
    '{{value0}} of {{value1}} checks passing',
    { value0: summary.passed, value1: summary.total }
  )
}

export function getChecksPillTone(item: ChecksPillItem): string {
  const state = getProviderChecksOutcome(item.checksSummary)
  if (state === 'success') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (state === 'failure') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200'
  }
  if (state === 'pending') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  }
  return 'border-border/60 bg-background/70 text-muted-foreground'
}
