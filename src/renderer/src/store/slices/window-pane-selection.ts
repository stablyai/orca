import type { AppState } from '../types'
import type {
  WorkspaceView,
  WindowPaneLayout,
  WorkspacePane
} from '../../../../shared/window-pane-types'
import { toVisibleTabType, type Tab } from '../../../../shared/tab-types'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { createBrowserUuid } from '@/lib/browser-uuid'

export function tabExecutionHost(state: AppState, tab: Tab) {
  return tab.executionHostId ?? getResolvedExecutionHostIdForWorktree(state, tab.worktreeId)
}

export function resolveWorkspaceView(
  state: AppState,
  view: WorkspaceView,
  tabs = state.unifiedTabsByWorktree[view.worktreeId]
): Tab | undefined {
  return tabs?.find(
    (tab) =>
      tab.id === view.tabId &&
      tab.entityId === view.entityId &&
      tab.contentType === view.contentType &&
      tabExecutionHost(state, tab) === view.executionHostId
  )
}

export function paneSelectionPatch(
  state: AppState,
  view?: WorkspaceView,
  workspace?: WorkspacePane['workspace']
): Partial<AppState> {
  const owner = view ?? workspace
  const ownerPatch: Partial<AppState> = {
    activeWorktreeId: owner?.worktreeId ?? null,
    activeWorkspaceExecutionHostId: owner?.executionHostId ?? null,
    activeWorkspaceKey: owner
      ? isWorkspaceKey(owner.worktreeId)
        ? owner.worktreeId
        : worktreeWorkspaceKey(owner.worktreeId)
      : null,
    activePendingCreationId: null,
    activeRepoId: owner
      ? (state.getKnownWorktreeById(owner.worktreeId, owner.executionHostId)?.repoId ?? null)
      : null
  }
  if (!view) {
    return {
      ...ownerPatch,
      activeTabId: null,
      activeFileId: null,
      activeBrowserTabId: null,
      activeTabType: 'terminal'
    }
  }
  const tab = resolveWorkspaceView(state, view)
  if (!tab) {
    return {
      ...ownerPatch,
      activeTabId: null,
      activeFileId: null,
      activeBrowserTabId: null,
      activeTabType: toVisibleTabType(view.contentType)
    }
  }
  const worktreeId = view.worktreeId
  const type = toVisibleTabType(tab.contentType)
  return {
    ...ownerPatch,
    activeTabType: type,
    activeTabId:
      type === 'terminal' ? tab.entityId : type === 'agent-session' ? tab.id : state.activeTabId,
    activeFileId: type === 'editor' ? tab.entityId : state.activeFileId,
    activeBrowserTabId: type === 'browser' ? tab.entityId : state.activeBrowserTabId,
    activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [worktreeId]: tab.groupId },
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: (state.groupsByWorktree[worktreeId] ?? []).map((group) =>
        group.id === tab.groupId ? { ...group, activeTabId: tab.id } : group
      )
    }
  }
}

export function appendWorkspaceViews(
  state: AppState,
  layout: WindowPaneLayout,
  unplacedOnly = false
): WindowPaneLayout {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return layout
  }
  const pane = layout.panes[layout.activePaneId]
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const preferred = state.getActiveTab(worktreeId)
  const views = { ...layout.views }
  const viewIds = [...pane.viewIds]
  const host =
    state.activeWorkspaceExecutionHostId ??
    (preferred && tabExecutionHost(state, preferred)) ??
    getResolvedExecutionHostIdForWorktree(state, worktreeId)
  for (const tab of tabs) {
    const executionHostId = tabExecutionHost(state, tab)
    if (!executionHostId || (host && executionHostId !== host)) {
      continue
    }
    if (
      pane.dismissedTabKeys?.includes(
        workspaceTabKey({ worktreeId, executionHostId, tabId: tab.id })
      )
    ) {
      continue
    }
    if (
      (unplacedOnly ? Object.keys(views) : viewIds).some(
        (id) =>
          views[id].tabId === tab.id &&
          views[id].worktreeId === worktreeId &&
          views[id].executionHostId === executionHostId
      )
    ) {
      continue
    }
    const id = createBrowserUuid()
    views[id] = {
      id,
      executionHostId,
      worktreeId,
      tabId: tab.id,
      entityId: tab.entityId,
      contentType: tab.contentType,
      label: tab.customLabel ?? tab.label
    }
    viewIds.push(id)
  }
  const current = views[pane.selectedViewId ?? '']
  const matchesOwner = (view: WorkspaceView) =>
    view.worktreeId === worktreeId && view.executionHostId === host
  const selectedViewId =
    (current && current.tabId === preferred?.id && matchesOwner(current) ? current.id : null) ??
    viewIds.find((id) => views[id].tabId === preferred?.id && matchesOwner(views[id])) ??
    (pane.selectedViewId && matchesOwner(views[pane.selectedViewId])
      ? pane.selectedViewId
      : null) ??
    viewIds.find((id) => matchesOwner(views[id])) ??
    null
  const workspace = host ? { worktreeId, executionHostId: host } : pane.workspace
  if (
    viewIds.length === pane.viewIds.length &&
    selectedViewId === pane.selectedViewId &&
    workspace?.worktreeId === pane.workspace?.worktreeId &&
    workspace?.executionHostId === pane.workspace?.executionHostId
  ) {
    return layout
  }
  return {
    ...layout,
    views,
    panes: { ...layout.panes, [pane.id]: { ...pane, viewIds, selectedViewId, workspace } }
  }
}

export function workspaceTabKey(
  view: Pick<WorkspaceView, 'worktreeId' | 'executionHostId' | 'tabId'>
): string {
  return JSON.stringify([view.executionHostId, view.worktreeId, view.tabId])
}

export function sameWorkspaceSession(first: WorkspaceView, second: WorkspaceView): boolean {
  return (
    first.worktreeId === second.worktreeId &&
    first.executionHostId === second.executionHostId &&
    first.contentType === second.contentType &&
    first.entityId === second.entityId
  )
}

export function visiblePaneViews(layout: WindowPaneLayout | null | undefined): WorkspaceView[] {
  if (!layout) {
    return []
  }
  return Object.values(layout.panes).flatMap((pane) =>
    (!layout.expandedPaneId || layout.expandedPaneId === pane.id) && pane.selectedViewId
      ? [layout.views[pane.selectedViewId]]
      : []
  )
}
