import type { AppState } from '../types'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { pickNextActiveTab, sanitizeRecentTabIds } from './tab-group-state'
import { collapseGroupLayout } from './tab-group-layout-removal'
import { buildTransferredTerminalLocalProjectionRemoval } from './terminal-window-transfer-local-projection'

type RemovalResult = { ok: true; patch: Partial<AppState> | null } | { ok: false }

function withoutKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(source, key)) {
    return source
  }
  const next = { ...source }
  delete next[key]
  return next
}

function withoutTabFromOrders(
  source: AppState['tabBarOrderByWorktree'],
  tabId: string
): AppState['tabBarOrderByWorktree'] {
  if (!Object.values(source).some((order) => order.includes(tabId))) {
    return source
  }
  return Object.fromEntries(
    Object.entries(source).map(([key, order]) => [key, order.filter((id) => id !== tabId)])
  )
}

function changedFields(state: AppState, candidate: Partial<AppState>): Partial<AppState> {
  return Object.fromEntries(
    (Object.entries(candidate) as [keyof AppState, AppState[keyof AppState]][]).filter(
      ([key, value]) => !Object.is(state[key], value)
    )
  ) as Partial<AppState>
}

function tabScopedRemovalPatch(state: AppState, tabId: string): Partial<AppState> {
  return changedFields(state, {
    ...buildTransferredTerminalLocalProjectionRemoval(state, tabId),
    ptyIdsByTabId: withoutKey(state.ptyIdsByTabId, tabId),
    terminalLayoutsByTabId: withoutKey(state.terminalLayoutsByTabId, tabId),
    lastKnownRelayPtyIdByTabId: withoutKey(state.lastKnownRelayPtyIdByTabId, tabId),
    deferredSshSessionIdsByTabId: withoutKey(state.deferredSshSessionIdsByTabId, tabId),
    pendingReconnectPtyIdByTabId: withoutKey(state.pendingReconnectPtyIdByTabId, tabId),
    directSshPaneRetryByTabId: withoutKey(state.directSshPaneRetryByTabId, tabId),
    directSshLivePtyBindingByTabId: withoutKey(state.directSshLivePtyBindingByTabId, tabId),
    directSshPaneRetryHistoryByTabId: withoutKey(state.directSshPaneRetryHistoryByTabId, tabId),
    runtimePaneTitlesByTabId: withoutKey(state.runtimePaneTitlesByTabId, tabId),
    expandedPaneByTabId: withoutKey(state.expandedPaneByTabId, tabId),
    canExpandPaneByTabId: withoutKey(state.canExpandPaneByTabId, tabId),
    pendingStartupByTabId: withoutKey(state.pendingStartupByTabId, tabId),
    pendingInitialCwdByTabId: withoutKey(state.pendingInitialCwdByTabId, tabId),
    pendingSetupSplitByTabId: withoutKey(state.pendingSetupSplitByTabId, tabId),
    pendingIssueCommandSplitByTabId: withoutKey(state.pendingIssueCommandSplitByTabId, tabId),
    automaticAgentResumeClaimsByTabId: withoutKey(state.automaticAgentResumeClaimsByTabId, tabId),
    nativeChatLaunchPromptByTabId: withoutKey(state.nativeChatLaunchPromptByTabId, tabId),
    nativeChatLaunchDraftByTabId: withoutKey(state.nativeChatLaunchDraftByTabId, tabId),
    unreadTerminalTabs: withoutKey(state.unreadTerminalTabs, tabId),
    tabBarOrderByWorktree: withoutTabFromOrders(state.tabBarOrderByWorktree, tabId)
  })
}

function selectedSurface(
  state: AppState,
  worktreeId: string,
  groups: readonly TabGroup[],
  unifiedTabs: readonly Tab[],
  activeGroupId: string | undefined
): { tab: Tab | null; type: WorkspaceVisibleTabType } {
  const group =
    groups.find(({ id }) => id === activeGroupId) ??
    groups.find(({ tabOrder }) => tabOrder.length > 0) ??
    groups[0]
  const tab = group?.activeTabId
    ? (unifiedTabs.find(({ id }) => id === group.activeTabId) ?? null)
    : null
  if (tab) {
    return { tab, type: toVisibleTabType(tab.contentType) }
  }
  if (state.openFiles.some((file) => file.worktreeId === worktreeId)) {
    return { tab: null, type: 'editor' }
  }
  if (state.browserTabsByWorktree[worktreeId]?.length) {
    return { tab: null, type: 'browser' }
  }
  return { tab: null, type: 'terminal' }
}

export function buildTransferredTerminalRemovalPatch(
  state: AppState,
  tabId: string
): RemovalResult {
  const tabPatch = tabScopedRemovalPatch(state, tabId)
  const ownerWorktreeIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some(({ id }) => id === tabId)) {
      ownerWorktreeIds.add(worktreeId)
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    if (tabs.some((tab) => tab.contentType === 'terminal' && tab.entityId === tabId)) {
      ownerWorktreeIds.add(worktreeId)
    }
  }
  for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
    if (groups.some(({ tabOrder }) => tabOrder.includes(tabId))) {
      ownerWorktreeIds.add(worktreeId)
    }
  }
  if (ownerWorktreeIds.size === 0) {
    return { ok: true, patch: Object.keys(tabPatch).length > 0 ? tabPatch : null }
  }
  if (ownerWorktreeIds.size !== 1) {
    return { ok: false }
  }
  const worktreeId = [...ownerWorktreeIds][0]
  const nextTabs = (state.tabsByWorktree[worktreeId] ?? []).filter(({ id }) => id !== tabId)
  const removedUnifiedIds = new Set(
    (state.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'terminal' && tab.entityId === tabId)
      .map(({ id }) => id)
  )
  const removedGroupTabIds = new Set(removedUnifiedIds)
  if ((state.groupsByWorktree[worktreeId] ?? []).some(({ tabOrder }) => tabOrder.includes(tabId))) {
    removedGroupTabIds.add(tabId)
  }
  const nextUnifiedTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    ({ id }) => !removedUnifiedIds.has(id)
  )
  const currentGroups = state.groupsByWorktree[worktreeId] ?? []
  let nextGroups = currentGroups.map((group) => {
    const closingIds = group.tabOrder.filter((id) => removedGroupTabIds.has(id))
    if (closingIds.length === 0) {
      return group
    }
    const tabOrder = group.tabOrder.filter((id) => !removedGroupTabIds.has(id))
    const closingActive = Boolean(group.activeTabId && removedGroupTabIds.has(group.activeTabId))
    const activeTabId = closingActive
      ? pickNextActiveTab(group.tabOrder, group.recentTabIds, group.activeTabId!)
      : group.activeTabId
    return {
      ...group,
      activeTabId:
        activeTabId && tabOrder.includes(activeTabId) ? activeTabId : (tabOrder[0] ?? null),
      tabOrder,
      recentTabIds: sanitizeRecentTabIds(group.recentTabIds, tabOrder)
    }
  })
  const emptiedGroupIds = currentGroups
    .filter(
      ({ tabOrder }) =>
        tabOrder.some((id) => removedGroupTabIds.has(id)) &&
        tabOrder.every((id) => removedGroupTabIds.has(id))
    )
    .map(({ id }) => id)
  nextGroups = nextGroups.filter(({ id }) => !emptiedGroupIds.includes(id))
  let recentQuickCommandIdByGroup = state.recentQuickCommandIdByGroup
  if (emptiedGroupIds.some((groupId) => Object.hasOwn(recentQuickCommandIdByGroup, groupId))) {
    recentQuickCommandIdByGroup = { ...recentQuickCommandIdByGroup }
    for (const groupId of emptiedGroupIds) {
      delete recentQuickCommandIdByGroup[groupId]
    }
  }
  let nextLayoutByWorktree = state.layoutByWorktree
  let nextActiveGroupIdByWorktree = state.activeGroupIdByWorktree
  for (const groupId of emptiedGroupIds) {
    const collapsed = collapseGroupLayout(
      nextLayoutByWorktree,
      nextActiveGroupIdByWorktree,
      worktreeId,
      groupId,
      nextGroups[0]?.id ?? null
    )
    nextLayoutByWorktree = collapsed.layoutByWorktree
    nextActiveGroupIdByWorktree = collapsed.activeGroupIdByWorktree
  }
  const currentActiveGroupId = nextActiveGroupIdByWorktree[worktreeId]
  const activeGroupId =
    nextGroups.find(({ id, tabOrder }) => id === currentActiveGroupId && tabOrder.length > 0)?.id ??
    nextGroups.find(({ tabOrder }) => tabOrder.length > 0)?.id ??
    nextGroups.find(({ id }) => id === currentActiveGroupId)?.id ??
    nextGroups[0]?.id
  const activeGroupIdByWorktree = activeGroupId
    ? { ...nextActiveGroupIdByWorktree, [worktreeId]: activeGroupId }
    : withoutKey(nextActiveGroupIdByWorktree, worktreeId)
  const nextState = {
    ...state,
    tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: nextTabs },
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [worktreeId]: nextUnifiedTabs
    },
    groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: nextGroups },
    activeGroupIdByWorktree,
    layoutByWorktree: nextLayoutByWorktree
  }
  const selected = selectedSurface(
    nextState,
    worktreeId,
    nextGroups,
    nextUnifiedTabs,
    activeGroupId
  )
  const selectedTerminalId =
    selected.tab?.contentType === 'terminal'
      ? selected.tab.entityId
      : (nextTabs.find(({ id }) => id === state.activeTabIdByWorktree[worktreeId])?.id ??
        nextTabs[0]?.id ??
        null)
  const selectedFileId =
    selected.tab && toVisibleTabType(selected.tab.contentType) === 'editor'
      ? selected.tab.entityId
      : (state.openFiles.find(
          ({ id, worktreeId: ownerId }) =>
            id === state.activeFileIdByWorktree[worktreeId] && ownerId === worktreeId
        )?.id ??
        state.openFiles.find(({ worktreeId: ownerId }) => ownerId === worktreeId)?.id ??
        null)
  const selectedBrowserId =
    selected.tab?.contentType === 'browser'
      ? selected.tab.entityId
      : ((state.browserTabsByWorktree[worktreeId] ?? []).find(
          ({ id }) => id === state.activeBrowserTabIdByWorktree[worktreeId]
        )?.id ??
        state.browserTabsByWorktree[worktreeId]?.[0]?.id ??
        null)
  const activeTabIdByWorktree = {
    ...state.activeTabIdByWorktree,
    [worktreeId]: selectedTerminalId
  }
  const activeTabTypeByWorktree = {
    ...state.activeTabTypeByWorktree,
    [worktreeId]: selected.type
  }
  const activeFileIdByWorktree = {
    ...state.activeFileIdByWorktree,
    [worktreeId]: selectedFileId
  }
  const activeBrowserTabIdByWorktree = {
    ...state.activeBrowserTabIdByWorktree,
    [worktreeId]: selectedBrowserId
  }
  const workspaceStillHasContent = Boolean(
    nextUnifiedTabs.length ||
    nextTabs.length ||
    state.openFiles.some((file) => file.worktreeId === worktreeId) ||
    state.browserTabsByWorktree[worktreeId]?.length
  )

  return {
    ok: true,
    patch: {
      ...tabPatch,
      tabsByWorktree: nextState.tabsByWorktree,
      unifiedTabsByWorktree: nextState.unifiedTabsByWorktree,
      groupsByWorktree: nextState.groupsByWorktree,
      layoutByWorktree: nextState.layoutByWorktree,
      recentQuickCommandIdByGroup,
      activeGroupIdByWorktree,
      activeTabIdByWorktree,
      activeTabTypeByWorktree,
      activeFileIdByWorktree,
      activeBrowserTabIdByWorktree,
      ...(state.activeWorktreeId === worktreeId
        ? workspaceStillHasContent
          ? {
              activeTabId: selectedTerminalId,
              activeTabType: selected.type,
              activeFileId: selectedFileId,
              activeBrowserTabId: selectedBrowserId
            }
          : {
              activeWorktreeId: null,
              activeWorkspaceKey: null,
              activeWorkspaceExecutionHostId: null,
              activeTabId: null,
              activeFileId: null,
              activeBrowserTabId: null,
              activeTabType: 'terminal' as const
            }
        : {})
    }
  }
}
