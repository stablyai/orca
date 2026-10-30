import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'

export function isInProgressWorkItem(
  item: AzureDevOpsWorkItem,
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
): boolean {
  const state = workItemTypes[item.workItemType]?.states.find((s) => s.name === item.state)
  return state?.category === 'InProgress'
}

/**
 * ADO's "In progress items" view option turned off: every item whose state
 * category is InProgress leaves the level, children included; a child in
 * progress under a visible item leaves on its own.
 */
export function excludeInProgressItems(
  page: AzureDevOpsBacklogPage,
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
): AzureDevOpsBacklogPage {
  const items = page.items.filter((item) => !isInProgressWorkItem(item, workItemTypes))
  const children = page.children.filter((child) => !isInProgressWorkItem(child, workItemTypes))
  const keptChildren = new Set(children.map((c) => c.id))
  const childrenByParent: Record<number, number[]> = {}
  for (const item of items) {
    childrenByParent[item.id] = (page.childrenByParent[item.id] ?? []).filter((id) =>
      keptChildren.has(id)
    )
  }
  return { ...page, items, children, childrenByParent }
}
