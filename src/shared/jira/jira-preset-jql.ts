import type { JiraIssueFilter, JiraIssueListFilters } from './jira-types'
import { normalizeJiraStatusSelection } from './jira-quick-filters'

export function buildJiraPresetJql(
  filter: JiraIssueFilter,
  filters?: JiraIssueListFilters,
  statusField: 'statusCategory' | 'resolution' = 'statusCategory'
): string {
  const clauses: string[] = []
  if (filter === 'assigned' || filter === 'done') {
    clauses.push('assignee = currentUser()')
  } else if (filter === 'reported') {
    clauses.push('reporter = currentUser()')
  }
  const done = filter === 'done'
  if (statusField === 'resolution') {
    clauses.push(done ? 'resolution IS NOT EMPTY' : 'resolution = Unresolved')
  } else {
    clauses.push(done ? 'statusCategory = Done' : 'statusCategory != Done')
  }
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

// Older Jira Server has no statusCategory JQL field; resolution was the prior preset rule.
export async function searchJiraPreset<T>(
  filter: JiraIssueFilter,
  filters: JiraIssueListFilters | undefined,
  search: (jql: string) => Promise<T>
): Promise<T> {
  try {
    return await search(buildJiraPresetJql(filter, filters))
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('statusCategory')) {
      throw error
    }
    return await search(buildJiraPresetJql(filter, filters, 'resolution'))
  }
}
