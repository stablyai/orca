import type { JiraIssue, JiraPriority } from '../../../shared/types'

export type JiraIssueSortColumn = 'key' | 'title' | 'status' | 'priority' | 'assignee' | 'updated'

export type JiraIssueSortDirection = 'asc' | 'desc'
export type JiraPrioritiesBySite = ReadonlyMap<string, readonly JiraPriority[]>

// Why: Jira instances can use synonymous names for the same standard priority tier.
export const JIRA_PRIORITY_ORDER: Record<string, number> = {
  blocker: 99,
  highest: 99,
  critical: 99,
  high: 75,
  major: 75,
  medium: 50,
  normal: 50,
  low: 25,
  minor: 25,
  lowest: 1,
  trivial: 1
}

export function getJiraPriorityWeight(
  priorityName?: string,
  priorityId?: string,
  jiraPriorities: readonly JiraPriority[] = []
): number {
  if (!priorityName) {
    return 0
  }
  if (jiraPriorities.length > 0) {
    const idx = jiraPriorities.findIndex(
      (p) => p.id === priorityId || p.name.toLowerCase() === priorityName.toLowerCase()
    )
    if (idx !== -1) {
      // Why: site schemes have different tier counts, so raw indices are not cross-site comparable.
      if (jiraPriorities.length === 1) {
        return 50
      }
      return 1 + ((jiraPriorities.length - 1 - idx) / (jiraPriorities.length - 1)) * 98
    }
  }
  const nameKey = priorityName.toLowerCase()
  if (nameKey in JIRA_PRIORITY_ORDER) {
    return JIRA_PRIORITY_ORDER[nameKey]
  }
  // Why: custom priority IDs are opaque identifiers, not ordering ranks.
  return 50
}

export function sortJiraIssues(
  issues: readonly JiraIssue[],
  orderBy: JiraIssueSortColumn,
  orderDirection: JiraIssueSortDirection,
  jiraPrioritiesBySite: JiraPrioritiesBySite = new Map()
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
      const prioritiesA = jiraPrioritiesBySite.get(a.siteId ?? '')
      const prioritiesB = jiraPrioritiesBySite.get(b.siteId ?? '')
      const weightA = getJiraPriorityWeight(a.priority?.name, a.priority?.id, prioritiesA)
      const weightB = getJiraPriorityWeight(b.priority?.name, b.priority?.id, prioritiesB)
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
