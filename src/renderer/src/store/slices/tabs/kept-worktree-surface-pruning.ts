import type { AppState } from '../../types'
import { toVisibleTabType, type Tab, type TabGroup } from '../../../../../shared/tab-types'
import { sanitizeRecentTabIds } from '../tab-group-state'

/** Surfaces leaving workspaces that stay, such as one host's tabs under an id its twin publishes. */
export type KeptWorktreeSurfaceRemoval = {
  worktreeIds: ReadonlySet<string>
  terminalTabIds: ReadonlySet<string>
  fileIds: ReadonlySet<string>
  browserTabIds: ReadonlySet<string>
  /** Unified tab ids of non-file surfaces such as chats. */
  unifiedTabIds: ReadonlySet<string>
}

function isRemovedUnifiedTab(tab: Tab, removed: KeptWorktreeSurfaceRemoval): boolean {
  if (removed.unifiedTabIds.has(tab.id)) {
    return true
  }
  if (tab.contentType === 'terminal') {
    return removed.terminalTabIds.has(tab.entityId)
  }
  if (tab.contentType === 'browser') {
    return removed.browserTabIds.has(tab.entityId)
  }
  return toVisibleTabType(tab.contentType) === 'editor' && removed.fileIds.has(tab.entityId)
}

function pruneGroup(group: TabGroup, removedIds: ReadonlySet<string>): TabGroup {
  if (!group.tabOrder.some((id) => removedIds.has(id))) {
    return group
  }
  const tabOrder = group.tabOrder.filter((id) => !removedIds.has(id))
  const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, tabOrder)
  // Why MRU first: closing the active tab lands on the previously active one, as closeUnifiedTab does.
  const activeTabId =
    group.activeTabId && removedIds.has(group.activeTabId)
      ? (recentTabIds.at(-1) ?? tabOrder[0] ?? null)
      : group.activeTabId
  return {
    ...group,
    tabOrder,
    activeTabId,
    ...(group.recentTabIds ? { recentTabIds } : {})
  }
}

function withoutIds<T extends { id: string }>(items: T[], ids: ReadonlySet<string>): T[] {
  return items.some((item) => ids.has(item.id)) ? items.filter((item) => !ids.has(item.id)) : items
}

/** Per-field pruners for workspaces that stay while some of their surfaces leave. */
export function createKeptWorktreeSurfacePruners(
  s: Pick<AppState, 'unifiedTabsByWorktree'>,
  removed: KeptWorktreeSurfaceRemoval
) {
  const { worktreeIds } = removed
  const removedUnifiedIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (s.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => isRemovedUnifiedTab(tab, removed))
        .map((tab) => tab.id)
    )
  )
  const removedIds = new Set([
    ...removedUnifiedIds,
    ...removed.terminalTabIds,
    ...removed.fileIds,
    ...removed.browserTabIds
  ])
  // A removed selection falls back to a surviving surface.
  const dropSelectionOf = (ids: ReadonlySet<string>) => (value: string | null) =>
    typeof value === 'string' && ids.has(value) ? undefined : value
  return {
    tabs: (tabs: AppState['tabsByWorktree'][string]) => withoutIds(tabs, removed.terminalTabIds),
    unifiedTabs: (tabs: AppState['unifiedTabsByWorktree'][string]) =>
      withoutIds(tabs, removedUnifiedIds),
    groups: (groups: AppState['groupsByWorktree'][string]) => {
      const next = groups.map((group) => pruneGroup(group, removedIds))
      return next.every((group, index) => group === groups[index]) ? groups : next
    },
    tabBarOrder: (order: string[]) =>
      order.some((id) => removedIds.has(id)) ? order.filter((id) => !removedIds.has(id)) : order,
    browserTabs: (tabs: AppState['browserTabsByWorktree'][string]) =>
      withoutIds(tabs, removed.browserTabIds),
    activeTabIds: dropSelectionOf(removed.terminalTabIds),
    activeFileIds: dropSelectionOf(removed.fileIds),
    activeBrowserTabIds: dropSelectionOf(removed.browserTabIds)
  }
}
