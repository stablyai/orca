import type { JiraIssueFilter } from './jira-types'

export type JiraStatusCatalogItem = {
  name: string
  categoryKey: string
}

const STATUS_CATEGORY_ORDER = new Map<string, number>([
  ['new', 0],
  ['indeterminate', 1],
  ['done', 2]
])

function escapeJiraString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function compareStatusName(a: string, b: string): number {
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()
  if (aLower < bLower) {
    return -1
  }
  if (aLower > bLower) {
    return 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function statusCategoryRank(categoryKey: string): number {
  return STATUS_CATEGORY_ORDER.get(categoryKey) ?? 3
}

export function getJiraPresetBaseJql(filter: JiraIssueFilter): string {
  if (filter === 'assigned') {
    return 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  }
  if (filter === 'reported') {
    return 'reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  }
  if (filter === 'done') {
    return 'assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC'
  }
  return 'resolution = Unresolved ORDER BY updated DESC'
}

export function composeJiraStatusJql(baseJql: string, statusNames: string[]): string {
  if (statusNames.length === 0) {
    return baseJql
  }

  const statusClause = `AND status in (${statusNames
    .map((name) => `"${escapeJiraString(name)}"`)
    .join(', ')})`
  const orderByMatches = [...baseJql.matchAll(/\sORDER\s+BY\s/gi)]
  const lastOrderByMatch = orderByMatches.at(-1)

  if (lastOrderByMatch?.index === undefined) {
    return `${baseJql} ${statusClause}`
  }

  // Split the base first so a status name containing ORDER BY cannot affect placement.
  const orderByIndex = lastOrderByMatch.index
  return `${baseJql.slice(0, orderByIndex)} ${statusClause}${baseJql.slice(orderByIndex)}`
}

export function orderJiraStatusCatalog<T extends JiraStatusCatalogItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const categoryDelta = statusCategoryRank(a.categoryKey) - statusCategoryRank(b.categoryKey)
    return categoryDelta === 0 ? compareStatusName(a.name, b.name) : categoryDelta
  })
}
