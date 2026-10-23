import type { JiraIssueFilter, JiraIssueListFilters } from '../jira-types'
import { normalizeJiraStatusSelection } from '../jira-quick-filters'

export function buildJiraPresetJql(
  filter: JiraIssueFilter,
  filters?: JiraIssueListFilters
): string {
  const clauses: string[] = []
  if (filter === 'assigned' || filter === 'done') {
    clauses.push('assignee = currentUser()')
  } else if (filter === 'reported') {
    clauses.push('reporter = currentUser()')
  }
  clauses.push(filter === 'done' ? 'statusCategory = Done' : 'statusCategory != Done')
  const statuses = normalizeJiraStatusSelection(filters?.statuses)
  if (statuses.length > 0) {
    const names = statuses.map((name) => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    clauses.push(`status in (${names.join(', ')})`)
  }
  if (filters?.currentSprint) {
    clauses.push('sprint in openSprints()')
  }
  return `${clauses.join(' AND ')} ORDER BY updated DESC`
}
