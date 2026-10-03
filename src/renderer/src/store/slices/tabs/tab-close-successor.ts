import type { TabGroup } from '../../../../../shared/tab-types'
import { pickNextActiveTab } from '../tab-group-state'
import { getHiddenClusterTabIds } from './tab-cluster-model'

export function pickTabCloseSuccessor(
  group: Pick<TabGroup, 'activeTabId' | 'recentTabIds' | 'tabClusters'>,
  tabOrder: string[],
  closingTabId: string
): string | null {
  if (tabOrder.length <= 1) {
    return null
  }
  // Why: automatic close repair must not reveal a collapsed member while a visible survivor remains.
  const hiddenTabIds = group.tabClusters?.some((cluster) => cluster.collapsed)
    ? getHiddenClusterTabIds(group)
    : undefined
  const visibleOrder = hiddenTabIds?.size
    ? tabOrder.filter((tabId) => !hiddenTabIds.has(tabId))
    : tabOrder
  return pickNextActiveTab(
    visibleOrder.length > 1 ? visibleOrder : tabOrder,
    group.recentTabIds,
    closingTabId
  )
}
