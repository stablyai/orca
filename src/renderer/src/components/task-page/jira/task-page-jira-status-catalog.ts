import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import type { JiraProjectReference } from '../../../../../shared/jira/jira-project-reference'
import { getJiraProjectSelectionKey } from './task-page-jira-project-selection'

export function getJiraStatusCatalogScopeKey(
  sourceScopeKey: string,
  selectedSiteId: string | null | undefined,
  preset: string,
  project?: JiraProjectReference | null
): string {
  const scopeKey = `${sourceScopeKey}::${selectedSiteId}::${preset}`
  return project ? `${scopeKey}::${getJiraProjectSelectionKey(project)}` : scopeKey
}

export type JiraStatusCatalogItem = { name: string; categoryKey: string }
const STATUS_NAME_COLLATOR = new Intl.Collator('en', { sensitivity: 'base' })
const STATUS_NAME_TIE_BREAKER = new Intl.Collator('en')
const STATUS_CATEGORY_ORDER = new Map([
  ['new', 0],
  ['indeterminate', 1],
  ['done', 2]
])

export function buildJiraStatusCatalog(issues: readonly JiraIssue[]): JiraStatusCatalogItem[] {
  const statuses = new Map<string, JiraStatusCatalogItem>()
  for (const { status } of issues) {
    if (!statuses.has(status.name)) {
      statuses.set(status.name, { name: status.name, categoryKey: status.categoryKey })
    }
  }
  return orderJiraStatusCatalog([...statuses.values()])
}

export function orderJiraStatusCatalog(items: JiraStatusCatalogItem[]): JiraStatusCatalogItem[] {
  return [...items].sort((left, right) => {
    const category =
      (STATUS_CATEGORY_ORDER.get(left.categoryKey) ?? 3) -
      (STATUS_CATEGORY_ORDER.get(right.categoryKey) ?? 3)
    return (
      category ||
      STATUS_NAME_COLLATOR.compare(left.name, right.name) ||
      STATUS_NAME_TIE_BREAKER.compare(left.name, right.name)
    )
  })
}

export function includeSelectedJiraStatuses(
  catalog: JiraStatusCatalogItem[],
  selected: string[]
): JiraStatusCatalogItem[] {
  const known = new Set(catalog.map((status) => status.name))
  return orderJiraStatusCatalog([
    ...catalog,
    ...selected.filter((name) => !known.has(name)).map((name) => ({ name, categoryKey: 'other' }))
  ])
}
