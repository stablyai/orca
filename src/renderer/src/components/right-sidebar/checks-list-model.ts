import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'

export const CHECK_SORT_ORDER: Record<string, number> = {
  failure: 0,
  timed_out: 0,
  cancelled: 1,
  pending: 2,
  neutral: 3,
  skipped: 4,
  success: 5
}

export type CheckDetailsLoadState = {
  loading: boolean
  details: PRCheckRunDetails | null
  error: string | null
}

export function getCheckIdentityKey(check: PRCheckDetail, index: number): string {
  if (check.checkRunId) {
    return `check-run:${check.checkRunId}`
  }
  if (check.workflowRunId) {
    return `workflow-run:${check.workflowRunId}`
  }
  if (check.url) {
    return `url:${check.url}`
  }
  return `fallback:${check.name}:${index}`
}

export function getCheckDetailsKey(
  contextKey: string,
  check: PRCheckDetail,
  index: number
): string {
  return `${contextKey}::${getCheckIdentityKey(check, index)}`
}

export function getCheckConclusion(check: PRCheckDetail): NonNullable<PRCheckDetail['conclusion']> {
  return check.conclusion ?? 'pending'
}

export function isFailedCheck(check: PRCheckDetail): boolean {
  return ['failure', 'cancelled', 'timed_out'].includes(getCheckConclusion(check))
}

export function isFailureState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

export function getCheckStatusLabel(check: PRCheckDetail): string {
  const conclusion = getCheckConclusion(check)
  if (conclusion === 'success') {
    return 'Successful'
  }
  if (conclusion === 'failure') {
    return 'Failed'
  }
  if (conclusion === 'cancelled') {
    return 'Cancelled'
  }
  if (conclusion === 'timed_out') {
    return 'Timed out'
  }
  if (conclusion === 'neutral') {
    return 'Neutral'
  }
  if (conclusion === 'skipped') {
    return 'Skipped'
  }
  if (check.status === 'queued') {
    return 'Queued'
  }
  if (check.status === 'in_progress') {
    return 'In progress'
  }
  return 'Pending'
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

export function getFailedChecksForDetails(checks: PRCheckDetail[]): PRCheckDetail[] {
  return checks.filter(isFailedCheck)
}
