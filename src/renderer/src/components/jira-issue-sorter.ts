import type { JiraIssue, JiraPriority } from '../../../shared/types'

// Explaining why JIRA_PRIORITY_ORDER maps specific terms to standard tiers:
// Lowest/trivial maps to 1, while blocker/highest/critical maps to 99 so that ascending sort puts lowest first.
export const JIRA_PRIORITY_ORDER: Record<string, number> = {
  blocker: 99,
  highest: 99,
  critical: 99,
  high: 4,
  major: 4,
  medium: 3,
  normal: 3,
  low: 2,
  minor: 2,
  lowest: 1,
  trivial: 1
}

// Explaining why the fallback weight is 0:
// We assign 0 for missing priorities so they always sort to the beginning (as the lowest).
export function getJiraPriorityWeight(
  priorityName?: string,
  priorityId?: string,
  jiraPriorities: JiraPriority[] = []
): number {
  if (!priorityName) {
    return 0
  }
  if (jiraPriorities.length > 0) {
    const idx = jiraPriorities.findIndex(
      (p) => p.id === priorityId || p.name.toLowerCase() === priorityName.toLowerCase()
    )
    if (idx !== -1) {
      // Invert index because jiraPriorities is returned from Jira API ordered Highest-to-Lowest.
      // So index 0 is Highest (largest weight) and index length-1 is Lowest (weight 0).
      return jiraPriorities.length - 1 - idx
    }
  }
  const nameKey = priorityName.toLowerCase()
  if (nameKey in JIRA_PRIORITY_ORDER) {
    return JIRA_PRIORITY_ORDER[nameKey]
  }
  if (priorityId) {
    const parsed = Number.parseInt(priorityId, 10)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return 3
}

export function sortJiraIssues(
  issues: JiraIssue[],
  orderBy: 'key' | 'title' | 'status' | 'priority' | 'assignee' | 'updated',
  orderDirection: 'asc' | 'desc',
  jiraPriorities: JiraPriority[] = []
): JiraIssue[] {
  return [...issues].sort((a, b) => {
    let comparison = 0
    if (orderBy === 'key') {
      comparison = a.key.localeCompare(b.key, undefined, { numeric: true })
    } else if (orderBy === 'title') {
      comparison = a.title.localeCompare(b.title)
    } else if (orderBy === 'status') {
      comparison = 0
    } else if (orderBy === 'priority') {
      const weightA = getJiraPriorityWeight(a.priority?.name, a.priority?.id, jiraPriorities)
      const weightB = getJiraPriorityWeight(b.priority?.name, b.priority?.id, jiraPriorities)
      // Explaining why weightA - weightB is used:
      // Lowest priority has weight 1 and highest priority has weight 99, so ascending sort shows lowest first.
      comparison = weightA - weightB
    } else if (orderBy === 'assignee') {
      const userA = a.assignee?.displayName ?? ''
      const userB = b.assignee?.displayName ?? ''
      comparison = userA.localeCompare(userB)
    } else if (orderBy === 'updated') {
      comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
    }
    return orderDirection === 'asc' ? comparison : -comparison
  })
}

// Explaining why we map category keys to numbers:
// We order status groups by 'new' (0), 'indeterminate' (1), and 'done' (2) as standard workflow progression.
export const JIRA_STATUS_CATEGORY_ORDER: Record<string, number> = {
  new: 0,
  indeterminate: 1,
  done: 2
}

export type JiraIssueSection = {
  key: string
  label: string
  categoryKey: string
  issues: JiraIssue[]
}

export function getJiraIssueSections(
  sortedIssues: JiraIssue[],
  orderBy: 'key' | 'title' | 'status' | 'priority' | 'assignee' | 'updated',
  orderDirection: 'asc' | 'desc'
): JiraIssueSection[] {
  const sections: JiraIssueSection[] = []
  const sectionsMap = new Map<string, { categoryKey: string; issues: JiraIssue[] }>()

  for (const issue of sortedIssues) {
    const statusName = issue.status.name
    if (!sectionsMap.has(statusName)) {
      sectionsMap.set(statusName, { categoryKey: issue.status.categoryKey, issues: [] })
    }
    sectionsMap.get(statusName)!.issues.push(issue)
  }

  sectionsMap.forEach(({ categoryKey, issues }, statusName) => {
    sections.push({
      key: statusName,
      label: statusName,
      categoryKey,
      issues
    })
  })

  sections.sort(
    (a, b) =>
      (JIRA_STATUS_CATEGORY_ORDER[a.categoryKey] ?? 99) -
        (JIRA_STATUS_CATEGORY_ORDER[b.categoryKey] ?? 99) || a.label.localeCompare(b.label)
  )

  if (orderBy === 'status' && orderDirection === 'desc') {
    return sections.toReversed()
  }
  return sections
}
