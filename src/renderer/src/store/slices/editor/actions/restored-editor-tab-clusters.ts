import type { TabCluster, TabGroup } from '../../../../../../shared/tab-types'
import { createTabClusterId, rekeyTabClusterMembers } from '../../tabs/tab-cluster-model'
import { removeTabIdsFromGroup } from '../file-ids/open-file-path-rekey'

export function carryRestoredEditorTabClusters(
  targetGroup: TabGroup,
  sourceGroups: readonly TabGroup[],
  movedTabIds: ReadonlySet<string>,
  tabIdMigrations: ReadonlyMap<string, string>
): TabCluster[] | undefined {
  const removedTargetIds = new Set([...movedTabIds, ...tabIdMigrations.values()])
  const retainedTargetClusters = rekeyTabClusterMembers(
    removeTabIdsFromGroup(targetGroup, removedTargetIds).tabClusters,
    tabIdMigrations
  )
  const tabClusters = [...(retainedTargetClusters ?? [])]
  const clusterIds = new Set(tabClusters.map((cluster) => cluster.id))

  for (const group of sourceGroups) {
    for (const cluster of group.tabClusters ?? []) {
      const tabIds = cluster.tabIds.filter((tabId) => movedTabIds.has(tabId))
      if (tabIds.length === 0) {
        continue
      }
      const [rekeyed] = rekeyTabClusterMembers([{ ...cluster, tabIds }], tabIdMigrations) ?? []
      if (!rekeyed) {
        continue
      }
      const remainsInSource = cluster.tabIds.some((tabId) => !movedTabIds.has(tabId))
      // A partial transfer creates a distinct cluster rather than duplicating the source chip's id.
      const id = remainsInSource || clusterIds.has(rekeyed.id) ? createTabClusterId() : rekeyed.id
      clusterIds.add(id)
      tabClusters.push(id === rekeyed.id ? rekeyed : { ...rekeyed, id })
    }
  }

  return tabClusters.length > 0 ? tabClusters : undefined
}
