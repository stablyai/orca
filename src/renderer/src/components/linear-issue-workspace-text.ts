import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import type { LinearIssue } from '../../../shared/types'
import { getUsableLinearBranchName } from '../../../shared/new-workspace/workspace-source'

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatLinearIssueRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }
  const diffMs = date.getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }
  const diffDays = Math.round(diffHours / 24)
  return relativeTimeFormatter.format(diffDays, 'day')
}

export function buildLinearIssueBranchName(issue: LinearIssue): string {
  return getUsableLinearBranchName(issue.branchName) ?? getLinearIssueWorkspaceName(issue)
}
