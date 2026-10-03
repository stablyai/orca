import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findGroupAndWorktree } from '../tab-group-state'
import { moveTabsToPane } from './tabs-drop-actions'

export function createTabsClusterMoveActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'moveTabCluster'> {
  return {
    moveTabCluster: (sourceGroupId, clusterId, target) => {
      const source = findGroupAndWorktree(get().groupsByWorktree, sourceGroupId)
      const cluster = source?.group.tabClusters?.find((candidate) => candidate.id === clusterId)
      return source && cluster
        ? moveTabsToPane(
            set,
            get,
            source.worktreeId,
            sourceGroupId,
            cluster.tabIds,
            target,
            cluster
          )
        : false
    }
  }
}
