import { getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import type { LinearIssue } from '../../../shared/types'

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
  const titleSlug = getLinkedWorkItemSuggestedName(issue)
  const key = issue.identifier.toLowerCase()
  return titleSlug ? `${key}-${titleSlug}` : key
}

export function buildLinearIssuePrompt(issue: LinearIssue): string {
  const lines = [
    `Linear issue: ${issue.identifier} ${issue.title}`,
    `URL: ${issue.url}`,
    `State: ${issue.state.name}`,
    `Assignee: ${issue.assignee?.displayName ?? 'Unassigned'}`,
    `Team: ${issue.team.name}`
  ]
  if (issue.workspaceName) {
    lines.push(`Workspace: ${issue.workspaceName}`)
  }
  const description = issue.description?.trim()
  if (description) {
    lines.push('', 'Description:', description)
  }
  return lines.join('\n')
}
