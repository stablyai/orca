import {
  getHiddenClusterTabIds,
  type TabCluster,
  type TabGroup
} from '../../../../shared/tab-types'
import { getTabClusterSortableId } from '../tab-group/tab-drag-data'
import type { TabBarItem } from './tab-bar-item-model'

export type TabBarStripItem =
  | TabBarItem
  | {
      type: 'cluster'
      id: string
      data: TabCluster
    }

export function buildTabBarStripItems(
  items: readonly TabBarItem[],
  group: Pick<TabGroup, 'id' | 'tabClusters' | 'activeTabId'> | null,
  clusterByTabId: ReadonlyMap<string, TabCluster>
): TabBarStripItem[] {
  if (!group?.tabClusters?.length) {
    return [...items]
  }
  const hiddenTabIds = getHiddenClusterTabIds(group)
  const renderedClusterIds = new Set<string>()
  const stripItems: TabBarStripItem[] = []
  for (const item of items) {
    const cluster = clusterByTabId.get(item.unifiedTabId)
    if (cluster && !renderedClusterIds.has(cluster.id)) {
      stripItems.push({
        type: 'cluster',
        id: getTabClusterSortableId(group.id, cluster.id),
        data: cluster
      })
      renderedClusterIds.add(cluster.id)
    }
    if (!hiddenTabIds.has(item.unifiedTabId)) {
      stripItems.push(item)
    }
  }
  return stripItems
}
