import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../shared/github/check-types'
import { getCheckConclusion } from '../../../../../shared/pr-check-status-label'

export type CheckDetailsLoadState = {
  requestId?: number
  loading: boolean
  details: PRCheckRunDetails | null
  error: string | null
  /** Check state when the load failed or returned nothing, so a later state change can retry it. */
  errorAt?: { status: PRCheckDetail['status']; conclusion: PRCheckDetail['conclusion'] }
}

function getCheckIdentityKey(check: PRCheckDetail, index: number): string {
  if (check.checkRunId) {
    return `check-run:${check.checkRunId}`
  }
  if (check.workflowRunId) {
    return `workflow-run:${check.workflowRunId}`
  }
  // Use job IDs for URL-less GitLab jobs so pipeline reordering preserves cached logs.
  if (check.gitlabJobId) {
    return `gitlab-job:${check.gitlabJobId}`
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

export function isFailedCheck(check: PRCheckDetail): boolean {
  // action_required blocks merge; counting it as passing would contradict auto-merge readiness.
  return ['failure', 'cancelled', 'timed_out', 'action_required'].includes(
    getCheckConclusion(check)
  )
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

export type CheckDetailsStickySurface = 'sidebar' | 'card'

export function getCheckDetailsStickySurfaceClass(surface: CheckDetailsStickySurface): string {
  return surface === 'card' ? 'bg-card/95' : 'bg-sidebar/95'
}
