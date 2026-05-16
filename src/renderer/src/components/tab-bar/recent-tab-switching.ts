import type { CtrlTabOrderMode, Tab, TabContentType, TabGroup } from '../../../../shared/types'
import type { AppState } from '../../store/types'
import { sanitizeRecentTabIds } from '../../store/slices/tab-group-state'
import { getActiveTabNavOrder, type VisibleTabRef } from './group-tab-order'
import { getActiveEntityIdForTabType, type TypeCyclableTab } from '../terminal/tab-type-cycle'

export type RecentTabSwitcherItem = TypeCyclableTab & {
  key: string
  label: string
  contentType: TabContentType
  isDirty: boolean
}

export type RecentTabSwitcherModel = {
  items: RecentTabSwitcherItem[]
  activeIndex: number
}

type RecentTabSwitchingState = Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeFileId'
  | 'activeGroupIdByWorktree'
  | 'activeTabId'
  | 'activeTabType'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

export function normalizeCtrlTabOrderMode(
  value: CtrlTabOrderMode | null | undefined
): CtrlTabOrderMode {
  return value === 'sequential' ? 'sequential' : 'mru'
}

function getVisibleTabKey(tab: VisibleTabRef): string {
  return tab.tabId ?? `${tab.type}:${tab.id}`
}

function findActiveGroup(
  state: Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>,
  worktreeId: string
): TabGroup | null {
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  return groupId
    ? ((state.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === groupId) ?? null)
    : null
}

function getActiveVisibleTabKey(
  state: Pick<
    AppState,
    | 'activeBrowserTabId'
    | 'activeFileId'
    | 'activeGroupIdByWorktree'
    | 'activeTabId'
    | 'activeTabType'
    | 'groupsByWorktree'
  >,
  worktreeId: string,
  entries: readonly VisibleTabRef[]
): string | null {
  const group = findActiveGroup(state, worktreeId)
  if (group?.activeTabId && entries.some((entry) => entry.tabId === group.activeTabId)) {
    return group.activeTabId
  }

  const activeEntityId = getActiveEntityIdForTabType(
    state.activeTabType,
    state.activeTabId,
    state.activeFileId,
    state.activeBrowserTabId
  )
  const activeEntry =
    activeEntityId == null
      ? null
      : (entries.find(
          (entry) => entry.type === state.activeTabType && entry.id === activeEntityId
        ) ?? null)
  return activeEntry ? getVisibleTabKey(activeEntry) : null
}

function getTabLabel(tab: Tab | undefined, fallback: string): string {
  return tab?.customLabel?.trim() || tab?.label?.trim() || fallback
}

function toSwitcherItem(
  entry: VisibleTabRef,
  tabById: ReadonlyMap<string, Tab>,
  dirtyFileIds: ReadonlySet<string>
): RecentTabSwitcherItem {
  const backingTab = entry.tabId ? tabById.get(entry.tabId) : undefined
  return {
    ...entry,
    key: getVisibleTabKey(entry),
    label: getTabLabel(backingTab, entry.id),
    contentType: backingTab?.contentType ?? (entry.type === 'editor' ? 'editor' : entry.type),
    isDirty: entry.type === 'editor' && dirtyFileIds.has(entry.id)
  }
}

function orderByMru(
  entries: readonly VisibleTabRef[],
  tabsByKey: ReadonlyMap<string, RecentTabSwitcherItem>,
  group: TabGroup | null,
  activeKey: string | null
): RecentTabSwitcherItem[] {
  const visibleTabIds = entries.flatMap((entry) => (entry.tabId ? [entry.tabId] : []))
  const recentTabIds = group ? sanitizeRecentTabIds(group.recentTabIds, visibleTabIds) : []
  const ordered: RecentTabSwitcherItem[] = []
  const seen = new Set<string>()

  for (let i = recentTabIds.length - 1; i >= 0; i--) {
    const item = tabsByKey.get(recentTabIds[i])
    if (!item || seen.has(item.key)) {
      continue
    }
    ordered.push(item)
    seen.add(item.key)
  }

  for (const entry of entries) {
    const item = tabsByKey.get(getVisibleTabKey(entry))
    if (!item || seen.has(item.key)) {
      continue
    }
    ordered.push(item)
    seen.add(item.key)
  }

  const activeIndex = activeKey ? ordered.findIndex((item) => item.key === activeKey) : -1
  if (activeIndex > 0) {
    // Why: if persisted MRU data is stale, the active tab still belongs at
    // the top so the first Ctrl+Tab press quick-toggles to the previous tab.
    const [active] = ordered.splice(activeIndex, 1)
    ordered.unshift(active)
  }

  return ordered
}

export function buildRecentTabSwitcherModel(
  state: RecentTabSwitchingState,
  worktreeId: string,
  mode: CtrlTabOrderMode
): RecentTabSwitcherModel | null {
  const visibleEntries = getActiveTabNavOrder(state, worktreeId)
  if (visibleEntries.length <= 1) {
    return null
  }

  const tabById = new Map(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  const dirtyFileIds = new Set(
    state.openFiles
      .filter((file) => file.worktreeId === worktreeId && file.isDirty)
      .map((file) => file.id)
  )
  const itemByKey = new Map(
    visibleEntries.map((entry) => {
      const item = toSwitcherItem(entry, tabById, dirtyFileIds)
      return [item.key, item] as const
    })
  )
  const activeKey = getActiveVisibleTabKey(state, worktreeId, visibleEntries)
  const group = findActiveGroup(state, worktreeId)
  const orderedItems =
    mode === 'mru'
      ? orderByMru(visibleEntries, itemByKey, group, activeKey)
      : visibleEntries.map((entry) => itemByKey.get(getVisibleTabKey(entry))!).filter(Boolean)

  const activeIndex = activeKey ? orderedItems.findIndex((item) => item.key === activeKey) : -1
  return {
    items: orderedItems,
    activeIndex
  }
}

export function getNextRecentTabSwitcherIndex(
  itemCount: number,
  currentIndex: number,
  direction: 1 | -1
): number {
  if (itemCount <= 0) {
    return -1
  }
  if (currentIndex < 0) {
    return direction > 0 ? 0 : itemCount - 1
  }
  return (currentIndex + direction + itemCount) % itemCount
}
