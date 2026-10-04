import type { Tab } from '../../../../../shared/tab-types'
import { dedupeTabOrder } from '../tab-group-state'

export function partitionPinnedTabOrder(
  tabOrder: string[],
  tabs: Tab[],
  movingTabId: string
): string[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const withoutMoving = dedupeTabOrder(tabOrder).filter((id) => id !== movingTabId)
  const pinnedIds = withoutMoving.filter((id) => tabById.get(id)?.isPinned)
  const unpinnedIds = withoutMoving.filter((id) => !tabById.get(id)?.isPinned)
  return [...pinnedIds, movingTabId, ...unpinnedIds]
}

export function applyTabOrderSortValues(tabs: Tab[], tabOrder: string[]): Tab[] {
  const orderMap = new Map(tabOrder.map((id, index) => [id, index]))
  return tabs.map((tab) => {
    const sortOrder = orderMap.get(tab.id)
    return sortOrder === undefined || sortOrder === tab.sortOrder ? tab : { ...tab, sortOrder }
  })
}

/**
 * Insert `tabId` after `anchorTabId` when both share a pin partition; otherwise at the end of the
 * new tab's partition. Siblings keep their relative order.
 */
export function insertTabIdIntoOrder(
  tabOrder: readonly string[],
  tabs: readonly Tab[],
  tabId: string,
  isPinned: boolean,
  anchorTabId?: string
): string[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const order = dedupeTabOrder([...tabOrder]).filter((id) => id !== tabId)
  const firstUnpinnedIndex = order.findIndex((id) => !tabById.get(id)?.isPinned)
  const pinnedPrefixEnd = firstUnpinnedIndex === -1 ? order.length : firstUnpinnedIndex
  const anchorIndex = anchorTabId ? order.indexOf(anchorTabId) : -1
  const anchorIsPinned = anchorIndex !== -1 && tabById.get(order[anchorIndex])?.isPinned === true
  let index = isPinned ? pinnedPrefixEnd : order.length
  if (anchorIndex !== -1) {
    index = anchorIsPinned === isPinned ? anchorIndex + 1 : pinnedPrefixEnd
  }
  order.splice(index, 0, tabId)
  return order
}

export function isReplaceablePreviewContentType(contentType: Tab['contentType']): boolean {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details'
  )
}

export function canReplacePreviewContentType(
  incomingContentType: Tab['contentType'],
  existingContentType: Tab['contentType']
): boolean {
  if (isReplaceablePreviewContentType(incomingContentType)) {
    return isReplaceablePreviewContentType(existingContentType)
  }
  return existingContentType === incomingContentType
}
