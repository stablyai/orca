import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'

export type OpenCheckRunDetailsState = {
  contextKey: string
  check: PRCheckDetail
  details: PRCheckRunDetails | null
  loading: boolean
  error: string | null
}

export function getCheckRunTabIdentity(check: PRCheckDetail): string {
  if (check.checkRunId) {
    return `check-run:${check.checkRunId}`
  }
  if (check.workflowRunId) {
    return `workflow-run:${check.workflowRunId}`
  }
  if (check.url) {
    return `url:${check.url}`
  }
  return `name:${check.name}`
}

export function buildCheckRunDetailsTabId(worktreeId: string, check: PRCheckDetail): string {
  // Why: one tab per hosted check identity keeps the center pane stable across
  // PR head refreshes; contextKey lives on the tab state instead of the tab id.
  return `${worktreeId}::check-details::${getCheckRunTabIdentity(check)}`
}

export function getCheckRunDetailsTabLabel(check: PRCheckDetail): string {
  return check.name
}
