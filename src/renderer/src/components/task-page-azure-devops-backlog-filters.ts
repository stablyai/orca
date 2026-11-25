import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'

export type BacklogFilters = {
  keyword: string
  workItemTypes: ReadonlySet<string>
  /**
   * `uniqueName` values; the special value `unassigned` matches items with no
   * assignee. A display name also matches (ADO saved filters store those).
   */
  assignedTo: ReadonlySet<string>
  states: ReadonlySet<string>
  areaPaths: ReadonlySet<string>
  iterationPath: string | null
  tags: ReadonlySet<string>
}

export const UNASSIGNED_FILTER_VALUE = 'unassigned'

export const EMPTY_BACKLOG_FILTERS: BacklogFilters = {
  keyword: '',
  workItemTypes: new Set(),
  assignedTo: new Set(),
  states: new Set(),
  areaPaths: new Set(),
  iterationPath: null,
  tags: new Set()
}

export function isBacklogFilterEmpty(filters: BacklogFilters): boolean {
  return (
    !filters.keyword.trim() &&
    filters.workItemTypes.size === 0 &&
    filters.assignedTo.size === 0 &&
    filters.states.size === 0 &&
    filters.areaPaths.size === 0 &&
    filters.iterationPath === null &&
    filters.tags.size === 0
  )
}

function isUnderIteration(itemPath: string, filterPath: string): boolean {
  return itemPath === filterPath || itemPath.startsWith(`${filterPath}\\`)
}

export function matchesBacklogFilters(item: AzureDevOpsWorkItem, filters: BacklogFilters): boolean {
  const keyword = filters.keyword.trim().toLowerCase()
  // Why: a digits-only keyword is someone reaching for a work item number, so match the id by
  // prefix as well as the title; a keyword with letters in it never looks like an id.
  const matchesId = /^\d+$/.test(keyword) && String(item.id).includes(keyword)
  if (keyword && !item.title.toLowerCase().includes(keyword) && !matchesId) {
    return false
  }
  if (filters.workItemTypes.size > 0 && !filters.workItemTypes.has(item.workItemType)) {
    return false
  }
  if (filters.assignedTo.size > 0) {
    const keys = item.assignedTo
      ? [item.assignedTo.uniqueName, item.assignedTo.displayName]
      : [UNASSIGNED_FILTER_VALUE]
    if (!keys.some((key) => key !== null && filters.assignedTo.has(key))) {
      return false
    }
  }
  if (filters.states.size > 0 && !filters.states.has(item.state)) {
    return false
  }
  if (filters.areaPaths.size > 0 && !filters.areaPaths.has(item.areaPath)) {
    return false
  }
  if (
    filters.iterationPath !== null &&
    !isUnderIteration(item.iterationPath, filters.iterationPath)
  ) {
    return false
  }
  if (filters.tags.size > 0 && !item.tags.some((tag) => filters.tags.has(tag))) {
    return false
  }
  return true
}

export function filterBacklogPage(
  page: AzureDevOpsBacklogPage,
  filters: BacklogFilters
): AzureDevOpsBacklogPage {
  if (isBacklogFilterEmpty(filters)) {
    return page
  }
  const childById = new Map(page.children.map((c) => [c.id, c]))
  const childrenByParent: Record<number, number[]> = {}
  const keptChildren = new Set<number>()
  const items = page.items.filter((item) => {
    const matchingChildren = (page.childrenByParent[item.id] ?? []).filter((id) => {
      const child = childById.get(id)
      return child ? matchesBacklogFilters(child, filters) : false
    })
    if (!matchesBacklogFilters(item, filters) && matchingChildren.length === 0) {
      return false
    }
    childrenByParent[item.id] = matchingChildren
    for (const id of matchingChildren) {
      keptChildren.add(id)
    }
    return true
  })
  return {
    ...page,
    items,
    childrenByParent,
    children: page.children.filter((c) => keptChildren.has(c.id))
  }
}
