import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/types'
import { groupJiraIssuesByStatus } from './task-page-jira-issue-list'

export type TaskPageJiraBoardSection = {
  key: string
  label: string
  statusIds: string[]
  issues: JiraIssue[]
}

// Why: the list groups by statuses present in the issues, but a kanban must
// show every board column — including empty ones — so drops can target them.
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
      issues: section.issues
    }))
  }

  const sections: TaskPageJiraBoardSection[] = columns.map((column, index) => ({
    key: `column:${index}:${column.name}`,
    label: column.name,
    statusIds: [...column.statusIds],
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
    // Why: statuses outside the board config (other projects, hidden statuses)
    // still deserve a lane instead of silently dropping their issues.
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
