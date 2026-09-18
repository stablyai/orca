import type { MantisBTIssue } from '../../../shared/mantisbt-types'

export type MantisBTIssueSortColumn = 'title' | 'status' | 'priority' | 'handler' | 'updated'
export type MantisBTIssueSortDirection = 'asc' | 'desc'

// Why: MantisBT's default status/priority enums are fixed, monotonically
// increasing numeric ids (e.g. priority 10 none .. 60 immediate; status 10
// new .. 90 closed), unlike Jira where categories/order must be fetched
// per-site. A custom install may reorder these, but the numeric id still
// degrades gracefully to a stable, if imperfect, sort — no site-scoped
// lookup is required.
export function sortMantisBTIssues(
  issues: readonly MantisBTIssue[],
  orderBy: MantisBTIssueSortColumn,
  orderDirection: MantisBTIssueSortDirection
): MantisBTIssue[] {
  const numericKeys = new Map<MantisBTIssue, number>()
  if (
    issues.length > 1 &&
    (orderBy === 'priority' || orderBy === 'updated' || orderBy === 'status')
  ) {
    for (const issue of issues) {
      numericKeys.set(
        issue,
        orderBy === 'updated'
          ? new Date(issue.updatedAt).getTime()
          : orderBy === 'priority'
            ? Number(issue.priority?.id ?? 0)
            : Number(issue.status.id)
      )
    }
  }
  return [...issues].sort((a, b) => {
    let comparison = 0
    if (orderBy === 'title') {
      comparison = a.summary.localeCompare(b.summary)
    } else if (orderBy === 'status' || orderBy === 'priority' || orderBy === 'updated') {
      comparison = numericKeys.get(a)! - numericKeys.get(b)!
    } else if (orderBy === 'handler') {
      const userA = a.handler?.realName ?? a.handler?.name ?? ''
      const userB = b.handler?.realName ?? b.handler?.name ?? ''
      comparison = userA.localeCompare(userB)
    }
    return orderDirection === 'asc' ? comparison : -comparison
  })
}
