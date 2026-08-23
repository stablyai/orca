import type { AppState } from '../types'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { pickNextActiveTab, sanitizeRecentTabIds } from './tab-group-state'

type RemovalResult = { ok: true; patch: Partial<AppState> | null } | { ok: false }

function withoutKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(source, key)) {
    return source
  }
  const next = { ...source }
  delete next[key]
  return next
}

function withoutPanePrefix<T>(source: Record<string, T>, tabId: string): Record<string, T> {
  const entries = Object.entries(source).filter(([key]) => !key.startsWith(`${tabId}:`))
  return entries.length === Object.keys(source).length ? source : Object.fromEntries(entries)
}

function tabScopedRemovalPatch(state: AppState, tabId: string): Partial<AppState> {
  return {
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
    unreadTerminalPanes: withoutPanePrefix(state.unreadTerminalPanes, tabId),
    unreadAgentCompletionPanes: withoutPanePrefix(state.unreadAgentCompletionPanes, tabId),
    lastTerminalInputAtByPaneKey: withoutPanePrefix(state.lastTerminalInputAtByPaneKey, tabId),
    cacheTimerByKey: withoutPanePrefix(state.cacheTimerByKey, tabId),
    tabBarOrderByWorktree: Object.fromEntries(
      Object.entries(state.tabBarOrderByWorktree).map(([key, order]) => [
        key,
        order.filter((id) => id !== tabId)
      ])
    )
  }
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
  const hasBacking =
    ownerWorktreeIds.size > 0 ||
    Object.hasOwn(state.terminalLayoutsByTabId, tabId) ||
    Object.hasOwn(state.ptyIdsByTabId, tabId)
  if (!hasBacking) {
    return { ok: true, patch: null }
  }
  if (ownerWorktreeIds.size === 0) {
    return { ok: true, patch: tabScopedRemovalPatch(state, tabId) }
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
  const nextUnifiedTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    ({ id }) => !removedUnifiedIds.has(id)
  )
  const nextGroups = (state.groupsByWorktree[worktreeId] ?? []).map((group) => {
    const closingIds = group.tabOrder.filter((id) => removedUnifiedIds.has(id))
    if (closingIds.length === 0) {
      return group
    }
    const tabOrder = group.tabOrder.filter((id) => !removedUnifiedIds.has(id))
    const closingActive = Boolean(group.activeTabId && removedUnifiedIds.has(group.activeTabId))
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
  const currentActiveGroupId = state.activeGroupIdByWorktree[worktreeId]
  const activeGroupId =
    nextGroups.find(({ id, tabOrder }) => id === currentActiveGroupId && tabOrder.length > 0)?.id ??
    nextGroups.find(({ tabOrder }) => tabOrder.length > 0)?.id ??
    nextGroups.find(({ id }) => id === currentActiveGroupId)?.id ??
    nextGroups[0]?.id
  const activeGroupIdByWorktree = activeGroupId
    ? { ...state.activeGroupIdByWorktree, [worktreeId]: activeGroupId }
    : withoutKey(state.activeGroupIdByWorktree, worktreeId)
  const nextState = {
    ...state,
    tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: nextTabs },
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [worktreeId]: nextUnifiedTabs
    },
    groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: nextGroups },
    activeGroupIdByWorktree
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
      ...tabScopedRemovalPatch(state, tabId),
      tabsByWorktree: nextState.tabsByWorktree,
      unifiedTabsByWorktree: nextState.unifiedTabsByWorktree,
      groupsByWorktree: nextState.groupsByWorktree,
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
