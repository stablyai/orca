import type { TabGroup } from '../../../../../shared/tab-types'
import { normalizeTabGroupClusters } from './tab-cluster-model'

export function applyTransferredTabClusterMembership(
  group: TabGroup,
  tabIds: readonly string[],
  clusterId: string | null | undefined,
  pinnedTabIds: ReadonlySet<string>
): TabGroup {
  if (!group.tabClusters) {
    return normalizeTabGroupClusters(group, pinnedTabIds)
  }
  const movedIds = new Set(tabIds)
  const tabClusters = group.tabClusters.map((cluster) => {
    const remaining = cluster.tabIds.filter((id) => !movedIds.has(id))
    const joining = cluster.id === clusterId ? tabIds.filter((id) => !pinnedTabIds.has(id)) : []
    if (remaining.length === cluster.tabIds.length && !joining.length) {
      return cluster
    }
    return { ...cluster, tabIds: [...remaining, ...joining] }
  })
  return normalizeTabGroupClusters({ ...group, tabClusters }, pinnedTabIds)
}
