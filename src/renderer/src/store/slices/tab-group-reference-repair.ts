import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { dedupeTabOrder } from '../../../../shared/workspace-layout/tab-order'
import { sanitizeRecentTabIds } from './tab-group-state'

function collectLayoutGroupIds(node: TabGroupLayoutNode, groupIds: Set<string>): void {
  if (node.type === 'leaf') {
    groupIds.add(node.groupId)
    return
  }
  collectLayoutGroupIds(node.first, groupIds)
  collectLayoutGroupIds(node.second, groupIds)
}

export function layoutSpanningGroups(
  groups: readonly TabGroup[],
  existing?: TabGroupLayoutNode | null
): TabGroupLayoutNode {
  const first = existing ?? { type: 'leaf', groupId: groups[0].id }
  const laidOutGroupIds = new Set<string>()
  collectLayoutGroupIds(first, laidOutGroupIds)
  return groups
    .filter((group) => !laidOutGroupIds.has(group.id))
    .reduce<TabGroupLayoutNode>(
      (first, group) => ({
        type: 'split',
        direction: 'horizontal',
        first,
        second: { type: 'leaf', groupId: group.id }
      }),
      first
    )
}

/** Restore declared-owner rows omitted from a persisted tab order. */
export function appendOwnedTabIdsToGroups(
  groups: readonly TabGroup[],
  tabOwners: ReadonlyMap<string, string>
): TabGroup[] {
  const tabIdsByGroup = new Map<string, string[]>()
  for (const [tabId, groupId] of tabOwners) {
    const tabIds = tabIdsByGroup.get(groupId) ?? []
    tabIds.push(tabId)
    tabIdsByGroup.set(groupId, tabIds)
  }
  return groups.map((group) => {
    const ownedTabIds = tabIdsByGroup.get(group.id)
    if (!ownedTabIds) {
      return group
    }
    const orderedTabIds = new Set(group.tabOrder)
    const missingTabIds = ownedTabIds.filter((tabId) => !orderedTabIds.has(tabId))
    return missingTabIds.length > 0
      ? { ...group, tabOrder: [...group.tabOrder, ...missingTabIds] }
      : group
  })
}

/** Narrow a group to the tabs `tabOwners` assigns it, so no id is listed by two groups. */
export function restrictGroupToOwnedTabs(
  group: TabGroup,
  tabOwners: ReadonlyMap<string, string>,
  tabIdAliases?: ReadonlyMap<string, string>,
  /** Structured-launch slot ids this group keeps in its order before their tab row exists. */
  launchSlotIds: ReadonlySet<string> = new Set()
): TabGroup {
  const canonicalTabId = (tabId: string): string => tabIdAliases?.get(tabId) ?? tabId
  // Why: persisted tabOrder can contain duplicates from older buggy writes; restore the store
  // invariant before group operations branch on tab counts or neighbors.
  const tabOrder = dedupeTabOrder(
    group.tabOrder
      .map(canonicalTabId)
      .filter((tabId) => tabOwners.get(tabId) === group.id || launchSlotIds.has(tabId))
  )
  const canonicalActiveTabId = group.activeTabId ? canonicalTabId(group.activeTabId) : null
  const activeTabId =
    canonicalActiveTabId && tabOwners.get(canonicalActiveTabId) === group.id
      ? canonicalActiveTabId
      : null
  // Why: the active tab sits at the MRU tail so the first close after restore returns to the
  // previous tab rather than falling through to neighbor selection.
  const sanitizedRecent = sanitizeRecentTabIds(
    group.recentTabIds?.map(canonicalTabId),
    tabOrder.filter((tabId) => tabOwners.get(tabId) === group.id)
  )
  const recentTabIds =
    activeTabId && sanitizedRecent.at(-1) !== activeTabId
      ? [...sanitizedRecent.filter((id) => id !== activeTabId), activeTabId]
      : sanitizedRecent
  return { ...group, tabOrder, activeTabId, recentTabIds }
}

/** Re-home tabs stranded by a dropped group so hydration cannot render a blank workspace. */
export function adoptGrouplessTabs(
  tabsByWorktree: Record<string, Tab[]>,
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string>,
  layoutByWorktree: Record<string, TabGroupLayoutNode>
): void {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const groups = groupsByWorktree[worktreeId] ?? []
    const owningGroupIdByTabId = new Map<string, string>()
    for (const group of groups) {
      for (const tabId of group.tabOrder) {
        owningGroupIdByTabId.set(tabId, owningGroupIdByTabId.get(tabId) ?? group.id)
      }
    }
    const orphanIds = tabs.filter((tab) => !owningGroupIdByTabId.has(tab.id)).map((tab) => tab.id)
    const host: TabGroup = groups[0] ?? {
      id: createBrowserUuid(),
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const adopted = orphanIds.length
      ? {
          ...host,
          tabOrder: [...host.tabOrder, ...orphanIds],
          activeTabId: host.activeTabId ?? orphanIds[0]
        }
      : host
    for (const tabId of orphanIds) {
      owningGroupIdByTabId.set(tabId, adopted.id)
    }
    tabsByWorktree[worktreeId] = tabs.map((tab) => {
      const owningGroupId = owningGroupIdByTabId.get(tab.id)
      return owningGroupId && tab.groupId !== owningGroupId
        ? { ...tab, groupId: owningGroupId }
        : tab
    })
    if (orphanIds.length) {
      groupsByWorktree[worktreeId] = [adopted, ...groups.slice(1)]
      activeGroupIdByWorktree[worktreeId] ??= adopted.id
      layoutByWorktree[worktreeId] ??= { type: 'leaf', groupId: adopted.id }
    }
  }
}
