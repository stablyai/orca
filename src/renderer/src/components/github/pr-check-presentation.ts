import { getCheckConclusion } from '@/components/pr-check-counts'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { translate } from '@/i18n/i18n'

export function getCheckStatusLabel(check: PRCheckDetail): string {
  const conclusion = getCheckConclusion(check)
  if (conclusion === 'success') {
    return translate('components.github.prCheckPresentation.successful', 'Successful')
  }
  if (conclusion === 'failure') {
    return translate('components.github.prCheckPresentation.failed', 'Failed')
  }
  if (conclusion === 'cancelled') {
    return translate('components.github.prCheckPresentation.cancelled', 'Cancelled')
  }
  if (conclusion === 'timed_out') {
    return translate('components.github.prCheckPresentation.timedOut', 'Timed out')
  }
  if (conclusion === 'action_required') {
    return translate('components.github.prCheckPresentation.actionRequired', 'Action required')
  }
  if (conclusion === 'neutral') {
    return translate('components.github.prCheckPresentation.neutral', 'Neutral')
  }
  if (conclusion === 'skipped') {
    return translate('components.github.prCheckPresentation.skipped', 'Skipped')
  }
  if (check.status === 'queued') {
    return translate('components.github.prCheckPresentation.queued', 'Queued')
  }
  if (check.status === 'in_progress') {
    return translate('components.github.prCheckPresentation.inProgress', 'In progress')
  }
  return translate('components.github.prCheckPresentation.pending', 'Pending')
}

export function getCheckDetailsKey(check: PRCheckDetail): string {
  return String(check.checkRunId ?? check.workflowRunId ?? check.url ?? check.name)
}

export function formatCheckTimestamp(input: string | null | undefined): string | null {
  if (!input) {
    return null
  }
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
