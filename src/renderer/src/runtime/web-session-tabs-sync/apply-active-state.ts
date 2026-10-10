import type { applyWorktreeRecordUpdates } from './apply-worktree-records'
import { withWorktreeEntry, sameStringArray } from './state-equality-core'
import { toVisibleTabType } from './state-equality-files'
import {
  collectLayoutGroupIds,
  appendTabGroupLayout,
  pruneTabGroupLayout,
  tabGroupLayoutEqual
} from './tab-group-layout-tree'

type ActiveStateContext = ReturnType<typeof applyWorktreeRecordUpdates>

/** Resolve active ids, visible type, layout, and tab-bar order after reconciliation. */
export function applyActiveStateUpdates(context: ActiveStateContext) {
  const {
    state,
    snapshot,
    options,
    worktreeId,
    targetGroupId,
    nextGroups,
    clientOwnedPlacement,
    nextUnifiedTabs,
    nextTerminalTabs,
    nextWorktreeOpenFileIds,
    nextActiveUnifiedTabId,
    nextTabBarOrder,
    navigationIntentTab,
    honorSnapshotActiveFocus,
    intentMirroredAgent,
    activeMirroredAgentTabId,
    currentVisibleUnifiedTabId,
    currentVisibleStructuredTabId,
    currentActiveTerminalStillExists,
    currentActiveBrowserStillExists,
    currentActiveEditorStillExists,
    intentEditorFileId,
    nextActiveTerminalId,
    nextActiveBrowserWorkspaceId,
    nextActiveEditorFileId,
    intentTerminalId,
    intentBrowserWorkspaceId
  } = context

  const nextActiveGroupId = clientOwnedPlacement
    ? clientOwnedPlacement.activeGroupId
    : (nextGroups?.find((group) => group.activeTabId === nextActiveUnifiedTabId)?.id ??
      nextGroups?.find((group) => group.id === snapshot.activeGroupId)?.id ??
      nextGroups?.[0]?.id ??
      null)
  const nextActiveGroupIdByWorktree =
    nextGroups && state.activeGroupIdByWorktree[worktreeId] !== nextActiveGroupId
      ? withWorktreeEntry(
          state,
          'activeGroupIdByWorktree',
          worktreeId,
          nextActiveGroupId ?? targetGroupId,
          (current, next) => current === next,
          context.batchContext
        )
      : state.activeGroupIdByWorktree

  const nextLayoutByWorktree = (() => {
    if (!nextGroups) {
      return state.layoutByWorktree
    }
    if (clientOwnedPlacement) {
      const clientLayout =
        clientOwnedPlacement.layout ??
        (nextActiveGroupId ? { type: 'leaf' as const, groupId: nextActiveGroupId } : null)
      if (!clientLayout || tabGroupLayoutEqual(state.layoutByWorktree[worktreeId], clientLayout)) {
        return state.layoutByWorktree
      }
      return withWorktreeEntry(
        state,
        'layoutByWorktree',
        worktreeId,
        clientLayout,
        (current, next) => current === next,
        context.batchContext
      )
    }
    if (options?.preserveLocalLayout) {
      return state.layoutByWorktree
    }
    const validGroupIds = new Set(nextGroups.map((group) => group.id))
    const hostLayout = pruneTabGroupLayout(snapshot.tabGroupLayout, validGroupIds)
    const defaultLeafLayout = { type: 'leaf' as const, groupId: nextActiveGroupId ?? targetGroupId }
    const hostLayoutGroupIds = collectLayoutGroupIds(hostLayout ?? undefined)
    const hostGroupIds = new Set(snapshot.tabGroups?.map((group) => group.id) ?? [])
    const extraGroupIds = new Set(
      nextGroups
        .map((group) => group.id)
        .filter((groupId) =>
          hostLayout
            ? !hostLayoutGroupIds.has(groupId)
            : snapshot.tabGroups && snapshot.tabGroups.length > 0
              ? !hostGroupIds.has(groupId)
              : false
        )
    )
    const localExtraLayout = pruneTabGroupLayout(state.layoutByWorktree[worktreeId], extraGroupIds)
    const hostBaseLayout =
      hostLayout ?? (snapshot.tabGroups && snapshot.tabGroups.length > 0 ? defaultLeafLayout : null)
    const fallbackLayout =
      appendTabGroupLayout(hostBaseLayout, localExtraLayout) ??
      (snapshot.tabGroups && snapshot.tabGroups.length > 0
        ? defaultLeafLayout
        : state.layoutByWorktree[worktreeId]
          ? null
          : defaultLeafLayout)
    if (
      !fallbackLayout ||
      tabGroupLayoutEqual(state.layoutByWorktree[worktreeId], fallbackLayout)
    ) {
      return state.layoutByWorktree
    }
    return withWorktreeEntry(
      state,
      'layoutByWorktree',
      worktreeId,
      fallbackLayout,
      (current, next) => current === next,
      context.batchContext
    )
  })()

  const nextTabBarOrderByWorktree = withWorktreeEntry(
    state,
    'tabBarOrderByWorktree',
    worktreeId,
    nextTabBarOrder.length > 0 ? nextTabBarOrder : null,
    (a, b) => sameStringArray(a ?? [], b ?? []),
    context.batchContext
  )
  const nextActiveTabIdByWorktree =
    (state.activeTabIdByWorktree[worktreeId] ?? null) !==
    (intentMirroredAgent?.unifiedTab.id ?? currentVisibleStructuredTabId ?? nextActiveTerminalId)
      ? withWorktreeEntry(
          state,
          'activeTabIdByWorktree',
          worktreeId,
          intentMirroredAgent?.unifiedTab.id ??
            currentVisibleStructuredTabId ??
            nextActiveTerminalId,
          (current, next) => (current ?? null) === next,
          context.batchContext,
          false
        )
      : state.activeTabIdByWorktree
  const nextActiveBrowserTabIdByWorktree =
    (state.activeBrowserTabIdByWorktree[worktreeId] ?? null) !== nextActiveBrowserWorkspaceId
      ? withWorktreeEntry(
          state,
          'activeBrowserTabIdByWorktree',
          worktreeId,
          nextActiveBrowserWorkspaceId,
          (current, next) => (current ?? null) === next,
          context.batchContext,
          false
        )
      : state.activeBrowserTabIdByWorktree
  const nextActiveFileIdByWorktree =
    (state.activeFileIdByWorktree[worktreeId] ?? null) !== nextActiveEditorFileId
      ? withWorktreeEntry(
          state,
          'activeFileIdByWorktree',
          worktreeId,
          nextActiveEditorFileId,
          (current, next) => (current ?? null) === next,
          context.batchContext,
          false
        )
      : state.activeFileIdByWorktree

  const isActiveWorktree = state.activeWorktreeId === worktreeId
  const focusIntentVisibleTabType =
    navigationIntentTab?.type === 'agent-session' && intentMirroredAgent
      ? ('agent-session' as const)
      : navigationIntentTab?.type === 'browser' && intentBrowserWorkspaceId
        ? ('browser' as const)
        : navigationIntentTab?.type === 'terminal' && intentTerminalId
          ? ('terminal' as const)
          : intentEditorFileId
            ? ('editor' as const)
            : null
  const snapshotVisibleTabType =
    snapshot.activeTabType === 'agent-session' && activeMirroredAgentTabId
      ? ('agent-session' as const)
      : snapshot.activeTabType === 'browser' && nextActiveBrowserWorkspaceId
        ? ('browser' as const)
        : snapshot.activeTabType === 'terminal' && nextActiveTerminalId
          ? ('terminal' as const)
          : (snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file') &&
              nextActiveEditorFileId
            ? ('editor' as const)
            : null
  const currentVisibleTabType =
    state.activeTabTypeByWorktree[worktreeId] ?? (isActiveWorktree ? state.activeTabType : null)
  const currentVisibleTabTypeStillValid =
    currentVisibleStructuredTabId !== null
      ? ('agent-session' as const)
      : currentVisibleTabType === 'agent-session' &&
          currentVisibleUnifiedTabId &&
          nextUnifiedTabs?.some(
            (tab) => tab.id === currentVisibleUnifiedTabId && tab.contentType === 'agent-session'
          )
        ? ('agent-session' as const)
        : currentVisibleTabType === 'browser' && currentActiveBrowserStillExists
          ? ('browser' as const)
          : currentVisibleTabType === 'editor' && currentActiveEditorStillExists
            ? ('editor' as const)
            : currentVisibleTabType === 'terminal' && currentActiveTerminalStillExists
              ? ('terminal' as const)
              : null
  const activeUnifiedTab =
    nextActiveUnifiedTabId && nextUnifiedTabs
      ? (nextUnifiedTabs.find((tab) => tab.id === nextActiveUnifiedTabId) ?? null)
      : null
  const fallbackVisibleTabType =
    activeUnifiedTab !== null
      ? toVisibleTabType(activeUnifiedTab)
      : nextActiveTerminalId
        ? ('terminal' as const)
        : nextActiveBrowserWorkspaceId
          ? ('browser' as const)
          : nextActiveEditorFileId
            ? ('editor' as const)
            : ('terminal' as const)
  const nextVisibleTabType = honorSnapshotActiveFocus
    ? (focusIntentVisibleTabType ??
      currentVisibleTabTypeStillValid ??
      snapshotVisibleTabType ??
      fallbackVisibleTabType)
    : (currentVisibleTabTypeStillValid ?? snapshotVisibleTabType ?? fallbackVisibleTabType)

  const currentActiveTerminalStillValid =
    state.activeTabId && (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : null
  const currentActiveEditorStillValid =
    state.activeFileId && nextWorktreeOpenFileIds.has(state.activeFileId)
      ? state.activeFileId
      : null
  const nextActiveTabId = isActiveWorktree
    ? (intentMirroredAgent?.unifiedTab.id ??
      (snapshot.activeTabType === 'terminal'
        ? nextActiveTerminalId
        : (currentActiveTerminalStillValid ?? nextActiveTerminalId)))
    : state.activeTabId
  const nextActiveBrowserTabId = isActiveWorktree
    ? nextActiveBrowserWorkspaceId
    : state.activeBrowserTabId
  const nextActiveFileId = isActiveWorktree
    ? snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
      ? nextActiveEditorFileId
      : (currentActiveEditorStillValid ?? nextActiveEditorFileId)
    : state.activeFileId
  const nextActiveTabType = isActiveWorktree ? nextVisibleTabType : state.activeTabType
  const nextActiveTabTypeByWorktree =
    state.activeTabTypeByWorktree[worktreeId] !== nextVisibleTabType
      ? withWorktreeEntry(
          state,
          'activeTabTypeByWorktree',
          worktreeId,
          nextVisibleTabType,
          (current, next) => current === next,
          context.batchContext
        )
      : state.activeTabTypeByWorktree

  return {
    ...context,
    nextActiveGroupId,
    nextActiveGroupIdByWorktree,
    nextLayoutByWorktree,
    nextTabBarOrderByWorktree,
    nextActiveTabIdByWorktree,
    nextActiveBrowserTabIdByWorktree,
    nextActiveFileIdByWorktree,
    nextVisibleTabType,
    nextActiveTabId,
    nextActiveBrowserTabId,
    nextActiveFileId,
    nextActiveTabType,
    nextActiveTabTypeByWorktree
  }
}
