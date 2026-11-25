import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'

/**
 * Unpinned tabs left or right of `itemId` in `displayedOrder`, the order the tab bar draws (a bot's pinned Home first
 * wherever it is stored), so the closed set matches what the menu shows beside the tab.
 */
export function directionalCloseIds(
  displayedOrder: readonly string[],
  groupTabs: readonly Pick<Tab, 'id' | 'isPinned'>[],
  itemId: string,
  direction: 'left' | 'right'
): string[] {
  const index = displayedOrder.indexOf(itemId)
  if (index === -1) {
    return []
  }
  const order =
    direction === 'right' ? displayedOrder.slice(index + 1) : displayedOrder.slice(0, index)
  const closableIds = new Set(groupTabs.filter((tab) => !tab.isPinned).map((tab) => tab.id))
  return order.filter((id) => closableIds.has(id))
}
