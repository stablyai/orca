import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/jira/jira-types'
import { groupJiraIssuesByStatus } from './task-page-jira-issue-list'

export type TaskPageJiraBoardSection = {
  key: string
  label: string
  statusIds: string[]
  fromBoard?: boolean
  issues: JiraIssue[]
}

// Empty board columns remain available as drop targets.
export function buildJiraBoardSections(
  issues: readonly JiraIssue[],
  statusOrder: JiraProjectStatusOrder | null,
  statusDirection: 'asc' | 'desc' = 'asc'
): TaskPageJiraBoardSection[] {
  const columns = statusOrder?.columns ?? []
  if (columns.length === 0) {
    return groupJiraIssuesByStatus(issues, statusOrder, statusDirection).map((section) => ({
      key: section.key,
      label: section.label,
      statusIds: [...new Set(section.issues.map((issue) => issue.status.id))],
      fromBoard: false,
      issues: section.issues
    }))
  }

  const sections: TaskPageJiraBoardSection[] = columns.map((column, index) => ({
    key: `column:${index}:${column.name}`,
    label: column.name,
    statusIds: [...column.statusIds],
    fromBoard: true,
    issues: []
  }))
  const sectionByStatusId = new Map<string, TaskPageJiraBoardSection>()
  for (const section of sections) {
    for (const statusId of section.statusIds) {
      if (!sectionByStatusId.has(statusId)) {
        sectionByStatusId.set(statusId, section)
      }
    }
  }

  const extras = new Map<string, TaskPageJiraBoardSection>()
  for (const issue of issues) {
    const section = sectionByStatusId.get(issue.status.id)
    if (section) {
      section.issues.push(issue)
      continue
    }
    // Keep issues outside the board’s configured statuses visible in extra lanes.
    const extraKey = `status:${issue.status.name}`
    const extra = extras.get(extraKey)
    if (extra) {
      extra.issues.push(issue)
      if (!extra.statusIds.includes(issue.status.id)) {
        extra.statusIds.push(issue.status.id)
      }
    } else {
      extras.set(extraKey, {
        key: extraKey,
        label: issue.status.name,
        statusIds: [issue.status.id],
        issues: [issue]
      })
    }
  }

  const ordered = [
    ...sections,
    ...[...extras.values()].sort((a, b) => a.label.localeCompare(b.label))
  ]
  return statusDirection === 'desc' ? ordered.toReversed() : ordered
}
