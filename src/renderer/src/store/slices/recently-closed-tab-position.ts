import type { AppState } from '../types'

export type RecentlyClosedTabPosition = {
  tabBarIndex?: number
  groupId?: string
  groupIndex?: number
}

/** Reusable position lookup for one worktree. Bulk closes resolve a position per
 *  closed tab; without a shared index every lookup rescans tab order and group
 *  membership, which makes close-all cubic in the tab count. */
export type RecentlyClosedTabPositionIndex = {
  positionFor: (entityId: string) => RecentlyClosedTabPosition | undefined
}

export function createRecentlyClosedTabPositionIndex(
  state: Pick<AppState, 'tabBarOrderByWorktree' | 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string
): RecentlyClosedTabPositionIndex {
  const tabBarOrder = state.tabBarOrderByWorktree?.[worktreeId]
  const unifiedTabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const groups = state.groupsByWorktree?.[worktreeId] ?? []

  // First occurrence wins everywhere, matching the `indexOf`/`find` scans this replaces.
  const tabBarIndexByEntityId = new Map<string, number>()
  const tabByEntityId = new Map<string, (typeof unifiedTabs)[number]>()
  const tabById = new Map<string, (typeof unifiedTabs)[number]>()
  for (const tab of unifiedTabs) {
    if (!tabByEntityId.has(tab.entityId)) {
      tabByEntityId.set(tab.entityId, tab)
    }
    if (!tabById.has(tab.id)) {
      tabById.set(tab.id, tab)
    }
  }
  const tabBarEntityIdsByGroupId = new Map<string, (string | undefined)[]>()
  tabBarOrder?.forEach((entityId, index) => {
    if (!tabBarIndexByEntityId.has(entityId)) {
      tabBarIndexByEntityId.set(entityId, index)
    }
    const tab = tabByEntityId.get(entityId)
    if (!tab?.groupId) {
      return
    }
    const bucket = tabBarEntityIdsByGroupId.get(tab.groupId)
    if (bucket) {
      bucket.push(tab.entityId)
    } else {
      tabBarEntityIdsByGroupId.set(tab.groupId, [tab.entityId])
    }
  })

  const groupById = new Map<string, (typeof groups)[number]>()
  const tabOrderIndexByGroupId = new Map<string, Map<string, number>>()
  const groupOrderMatchesTabBarByGroupId = new Map<string, boolean>()
  for (const group of groups) {
    if (groupById.has(group.id)) {
      continue
    }
    groupById.set(group.id, group)
    const indexByTabId = new Map<string, number>()
    const groupTabEntityIds = group.tabOrder.map((tabId, index) => {
      if (!indexByTabId.has(tabId)) {
        indexByTabId.set(tabId, index)
      }
      return tabById.get(tabId)?.entityId
    })
    tabOrderIndexByGroupId.set(group.id, indexByTabId)
    const tabBarGroupEntityIds = tabBarEntityIdsByGroupId.get(group.id) ?? []
    groupOrderMatchesTabBarByGroupId.set(
      group.id,
      groupTabEntityIds.length === tabBarGroupEntityIds.length &&
        groupTabEntityIds.every((entityId, index) => entityId === tabBarGroupEntityIds[index])
    )
  }

  return {
    positionFor: (entityId) => {
      const tabBarIndex = tabBarOrder ? (tabBarIndexByEntityId.get(entityId) ?? -1) : -1
      const unifiedTab = tabByEntityId.get(entityId)
      const group = unifiedTab ? groupById.get(unifiedTab.groupId) : undefined
      const groupIndex =
        group && unifiedTab ? (tabOrderIndexByGroupId.get(group.id)?.get(unifiedTab.id) ?? -1) : -1
      if (tabBarIndex < 0 && (!group || groupIndex < 0)) {
        return undefined
      }
      const groupOrderMatchesTabBar =
        !group || (groupOrderMatchesTabBarByGroupId.get(group.id) ?? true)
      return {
        ...(tabBarIndex >= 0 && groupOrderMatchesTabBar ? { tabBarIndex } : {}),
        ...(group && groupIndex >= 0 ? { groupId: group.id, groupIndex } : {})
      }
    }
  }
}

export function getRecentlyClosedTabPosition(
  state: Pick<AppState, 'tabBarOrderByWorktree' | 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  entityId: string
): RecentlyClosedTabPosition | undefined {
  return createRecentlyClosedTabPositionIndex(state, worktreeId).positionFor(entityId)
}

export function insertTabAtRecentlyClosedPosition(
  order: readonly string[],
  tabId: string,
  position?: RecentlyClosedTabPosition
): string[] {
  const nextOrder = order.filter((id) => id !== tabId)
  const index = position?.tabBarIndex
  if (index === undefined) {
    return [...nextOrder, tabId]
  }
  nextOrder.splice(Math.min(Math.max(index, 0), nextOrder.length), 0, tabId)
  return nextOrder
}

export function restoreRecentlyClosedTabPosition(
  getState: () => Pick<
    AppState,
    | 'tabBarOrderByWorktree'
    | 'groupsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'setTabBarOrder'
    | 'reorderUnifiedTabs'
  >,
  worktreeId: string,
  entityId: string,
  position?: RecentlyClosedTabPosition
): void {
  if (!position) {
    return
  }
  const state = getState()
  const order = state.tabBarOrderByWorktree?.[worktreeId]
  if (order && typeof state.setTabBarOrder === 'function') {
    state.setTabBarOrder(worktreeId, insertTabAtRecentlyClosedPosition(order, entityId, position))
  }

  if (position?.groupIndex === undefined) {
    return
  }
  const unifiedTab = (getState().unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (candidate) =>
      candidate.entityId === entityId &&
      (position.groupId === undefined || candidate.groupId === position.groupId)
  )
  if (!unifiedTab) {
    return
  }
  const group = (getState().groupsByWorktree?.[worktreeId] ?? []).find(
    (candidate) => candidate.id === unifiedTab.groupId
  )
  if (!group) {
    return
  }
  if (typeof getState().reorderUnifiedTabs === 'function') {
    getState().reorderUnifiedTabs(
      group.id,
      insertTabAtRecentlyClosedPosition(group.tabOrder, unifiedTab.id, {
        tabBarIndex: position.groupIndex
      }),
      { recordInteraction: false }
    )
  }
}
