import type {
  CtrlTabOrderMode,
  CtrlTabScope,
  Tab,
  TabContentType,
  TabGroup
} from '../../../../shared/tab-types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { collectTabGroupLayoutGroupIds } from '../../../../shared/workspace-layout/tab-group-moves'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { resolveOpenTabOccupantAgent } from '@/lib/open-tab-occupant-agent'
import { orderRecentWorkspaceTabs } from '@/lib/recent-workspace-tab-rows'
import type { AppState } from '../../store/types'
import { sanitizeRecentTabIds } from '../../store/slices/tab-group-state'
import { getActiveTabNavOrder, type VisibleTabRef } from './group-tab-order'
import { getActiveEntityIdForTabType, type TypeCyclableTab } from '../terminal/tab-type-cycle'

export type RecentTabSwitcherItem = TypeCyclableTab & {
  key: string
  label: string
  contentType: TabContentType
  isDirty: boolean
  /** The chat's provider, or the agent that runs in a terminal; drives the row icon. */
  agent: TerminalAgent | null
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
  | 'agentStatusByPaneKey'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'openFiles'
  | 'paneForegroundAgentByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
> & { settings?: AppState['settings'] }

export function normalizeCtrlTabOrderMode(
  value: CtrlTabOrderMode | null | undefined
): CtrlTabOrderMode {
  return value === 'sequential' ? 'sequential' : 'mru'
}

export function normalizeCtrlTabScope(value: string | null | undefined): CtrlTabScope {
  return value === 'all' ? 'all' : 'workspace'
}

function getVisibleTabKey(tab: VisibleTabRef): string {
  return tab.tabId ?? `${tab.type}:${tab.id}`
}

// Why: no shortcut moves the focus to another tab strip, so This workspace lists every strip,
// panes from left to right. One strip keeps the exact list of the per-strip switcher.
function getWorkspaceTabOrder(state: RecentTabSwitchingState, worktreeId: string): VisibleTabRef[] {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (groups.length <= 1) {
    return getActiveTabNavOrder(state, worktreeId)
  }
  const groupIds = new Set([
    ...collectTabGroupLayoutGroupIds(state.layoutByWorktree[worktreeId]),
    ...groups.map((group) => group.id)
  ])
  return [...groupIds]
    .filter((groupId) => groups.some((group) => group.id === groupId))
    .flatMap((groupId) => getActiveTabNavOrder(state, worktreeId, {}, groupId))
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

function getTabLabel(
  tab: Tab | undefined,
  generatedTitlesEnabled: boolean,
  fallback: string
): string {
  return resolveUnifiedTabLabel(tab, generatedTitlesEnabled, fallback)
}

// Why: the same identity check as the tab strip and Cmd+J, so an agent terminal shows its agent icon.
function resolveRowAgent(
  state: RecentTabSwitchingState,
  entry: VisibleTabRef,
  backingTab: Tab | undefined,
  terminalTab: TerminalTab | undefined,
  label: string
): TerminalAgent | null {
  if (entry.type === 'agent-session') {
    return agentTypeToIconAgent(backingTab?.agentSessionAgent)
  }
  if (entry.type !== 'terminal') {
    return null
  }
  return resolveOpenTabOccupantAgent({
    tabId: entry.id,
    title: label,
    defaultTitle: terminalTab?.defaultTitle,
    launchAgent: terminalTab?.launchAgent,
    layout: state.terminalLayoutsByTabId[entry.id],
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey
  })
}

function toSwitcherItem(
  state: RecentTabSwitchingState,
  entry: VisibleTabRef,
  tabById: ReadonlyMap<string, Tab>,
  terminalTabById: ReadonlyMap<string, TerminalTab>,
  dirtyFileIds: ReadonlySet<string>,
  generatedTitlesEnabled: boolean
): RecentTabSwitcherItem {
  const backingTab = entry.tabId ? tabById.get(entry.tabId) : undefined
  const label = getTabLabel(backingTab, generatedTitlesEnabled, entry.id)
  return {
    ...entry,
    key: getVisibleTabKey(entry),
    label,
    contentType: backingTab?.contentType ?? (entry.type === 'editor' ? 'editor' : entry.type),
    isDirty: entry.type === 'editor' && dirtyFileIds.has(entry.id),
    agent: resolveRowAgent(state, entry, backingTab, terminalTabById.get(entry.id), label)
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

// Why: each strip keeps its own recent list, so across strips the visit times decide, as in All workspaces.
function orderByLastFocus(
  entries: readonly VisibleTabRef[],
  tabsByKey: ReadonlyMap<string, RecentTabSwitcherItem>,
  tabById: ReadonlyMap<string, Tab>,
  activeKey: string | null
): RecentTabSwitcherItem[] {
  const ordered = orderRecentWorkspaceTabs({
    rows: entries.map((entry) => ({
      id: getVisibleTabKey(entry),
      lastFocusedAt: entry.tabId ? tabById.get(entry.tabId)?.lastFocusedAt : undefined
    }))
  }).flatMap((key) => tabsByKey.get(key) ?? [])
  const activeIndex = activeKey ? ordered.findIndex((item) => item.key === activeKey) : -1
  if (activeIndex > 0) {
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
  const visibleEntries = getWorkspaceTabOrder(state, worktreeId)
  if (visibleEntries.length <= 1) {
    return null
  }

  const tabById = new Map(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  const terminalTabById = new Map(
    (state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  const dirtyFileIds = new Set(
    state.openFiles
      .filter((file) => file.worktreeId === worktreeId && file.isDirty)
      .map((file) => file.id)
  )
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const itemByKey = new Map(
    visibleEntries.map((entry) => {
      const item = toSwitcherItem(
        state,
        entry,
        tabById,
        terminalTabById,
        dirtyFileIds,
        generatedTitlesEnabled
      )
      return [item.key, item] as const
    })
  )
  const activeKey = getActiveVisibleTabKey(state, worktreeId, visibleEntries)
  const group = findActiveGroup(state, worktreeId)
  const splitIntoStrips = (state.groupsByWorktree[worktreeId] ?? []).length > 1
  const orderedItems =
    mode === 'mru'
      ? splitIntoStrips
        ? orderByLastFocus(visibleEntries, itemByKey, tabById, activeKey)
        : orderByMru(visibleEntries, itemByKey, group, activeKey)
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
