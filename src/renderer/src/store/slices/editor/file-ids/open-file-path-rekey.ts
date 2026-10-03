import type { AppState } from '../../../types'
import type { TabGroup } from '../../../../../../shared/tab-types'
import { pruneTabGroupLayoutForGroups } from '../../tabs-hydration'
import { sanitizeRecentTabIds } from '../../tab-group-state'

export function rekeyFileIdRecord<T>(
  record: Record<string, T>,
  migrations: ReadonlyMap<string, string>
): Record<string, T> {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const mapped = migrations.get(key)
    if (mapped !== undefined && mapped !== key) {
      next[mapped] = value
      changed = true
    } else {
      next[key] = value
    }
  }
  return changed ? next : record
}

export function nextActiveIdAfterRemoval(
  ids: readonly string[],
  recentIds: readonly string[] | undefined,
  removedIds: ReadonlySet<string>
): string | null {
  const recent = (recentIds ?? []).toReversed().find((id) => !removedIds.has(id))
  return recent ?? ids.find((id) => !removedIds.has(id)) ?? null
}

/** Removed tabs cannot retain membership in the pane's clusters. */
export function removeTabIdsFromGroup(group: TabGroup, removedIds: ReadonlySet<string>): TabGroup {
  const recentTabIds = group.recentTabIds ?? []
  const removesClusterMembers =
    group.tabClusters?.some((cluster) => cluster.tabIds.some((id) => removedIds.has(id))) ?? false
  const references =
    group.tabOrder.some((id) => removedIds.has(id)) ||
    recentTabIds.some((id) => removedIds.has(id)) ||
    (group.activeTabId !== null && removedIds.has(group.activeTabId)) ||
    removesClusterMembers
  if (!references) {
    return group
  }
  const tabOrder = group.tabOrder.filter((id) => !removedIds.has(id))
  const tabClusters = removesClusterMembers
    ? group.tabClusters?.flatMap((cluster) => {
        const tabIds = cluster.tabIds.filter((id) => !removedIds.has(id))
        return tabIds.length > 0
          ? [tabIds.length === cluster.tabIds.length ? cluster : { ...cluster, tabIds }]
          : []
      })
    : group.tabClusters
  const nextGroup = {
    ...group,
    activeTabId:
      group.activeTabId !== null && removedIds.has(group.activeTabId)
        ? nextActiveIdAfterRemoval(group.tabOrder, recentTabIds, removedIds)
        : group.activeTabId,
    tabOrder,
    recentTabIds: sanitizeRecentTabIds(recentTabIds, tabOrder)
  }
  if (tabClusters?.length) {
    nextGroup.tabClusters = tabClusters
  } else {
    delete nextGroup.tabClusters
  }
  return nextGroup
}

export function removeEmptyEditorGroups(
  previousGroups: TabGroup[],
  groups: TabGroup[],
  movedTabIds: ReadonlySet<string>,
  layout: AppState['layoutByWorktree'][string] | undefined
): { groups: TabGroup[]; layout: AppState['layoutByWorktree'][string] | undefined } {
  const emptiedGroupIds = new Set(
    previousGroups
      .filter(
        (group) =>
          group.tabOrder.some((id) => movedTabIds.has(id)) &&
          groups.find((candidate) => candidate.id === group.id)?.tabOrder.length === 0
      )
      .map((group) => group.id)
  )
  const remaining = groups.filter((group) => !emptiedGroupIds.has(group.id))
  if (remaining.length === 0) {
    return { groups: [], layout: undefined }
  }
  const validIds = new Set(remaining.map((group) => group.id))
  return {
    groups: remaining,
    layout: layout ? (pruneTabGroupLayoutForGroups(layout, validIds) ?? undefined) : undefined
  }
}
