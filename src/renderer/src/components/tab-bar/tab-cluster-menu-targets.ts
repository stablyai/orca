import type { TabCluster } from '../../../../shared/tab-types'
import type { TabStripSelection } from '@/store/slices/tabs/tabs-slice-contract'

export function getTabClusterMenuTargets({
  tabId,
  tabOrder,
  selection,
  pinnedTabIds,
  clusters
}: {
  tabId: string
  tabOrder: readonly string[]
  selection: TabStripSelection | null | undefined
  pinnedTabIds: ReadonlySet<string>
  clusters: readonly TabCluster[] | undefined
}) {
  const selectedIds = new Set(selection?.tabIds.includes(tabId) ? selection.tabIds : [tabId])
  const tabIds = tabOrder.filter((id) => selectedIds.has(id))
  const groupableTabIds = tabIds.filter((id) => !pinnedTabIds.has(id))
  const targetIds = new Set(groupableTabIds)
  return {
    tabIds,
    groupableTabIds,
    hasClusterMembers:
      clusters?.some((cluster) => cluster.tabIds.some((id) => targetIds.has(id))) ?? false
  }
}
