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
  _unplacedOnly = false
): WindowPaneLayout {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return layout
  }
  const views = { ...layout.views }
  const canonicalViewBySession = new Map<string, string>()
  const duplicateViewIds = new Set<string>()
  for (const [id, view] of Object.entries(views)) {
    const key = workspaceSessionKey(view)
    if (canonicalViewBySession.has(key)) {
      duplicateViewIds.add(id)
      delete views[id]
    } else {
      canonicalViewBySession.set(key, id)
    }
  }
  const normalizedPanes = Object.fromEntries(
    Object.entries(layout.panes).map(([id, candidate]) => {
      const viewIds = candidate.viewIds.filter((viewId) => !duplicateViewIds.has(viewId))
      return [
        id,
        {
          ...candidate,
          viewIds,
          selectedViewId:
            candidate.selectedViewId && !duplicateViewIds.has(candidate.selectedViewId)
              ? candidate.selectedViewId
              : (viewIds.at(-1) ?? null)
        }
      ]
    })
  )
  const pane = normalizedPanes[layout.activePaneId]
  if (!pane) {
    return layout
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const preferred = state.getActiveTab(worktreeId)
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
    const sessionKey = workspaceSessionKey({
      worktreeId,
      executionHostId,
      entityId: tab.entityId,
      contentType: tab.contentType
    })
    // A session has one placement across all panes. Different sessions may still
    // belong to the same project and branch.
    if (Object.values(views).some((view) => workspaceSessionKey(view) === sessionKey)) {
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
  const preferredView = preferred
    ? Object.values(views).find(
        (view) =>
          view.worktreeId === worktreeId &&
          view.executionHostId === host &&
          view.tabId === preferred.id
      )
    : undefined
  const preferredPane = preferredView
    ? Object.values(normalizedPanes).find((candidate) =>
        candidate.viewIds.includes(preferredView.id)
      )
    : undefined
  const selectedViewId = preferredView
    ? preferredView.id
    : ((current && current.tabId === preferred?.id && matchesOwner(current) ? current.id : null) ??
      viewIds.find((id) => views[id].tabId === preferred?.id && matchesOwner(views[id])) ??
      (pane.selectedViewId && matchesOwner(views[pane.selectedViewId])
        ? pane.selectedViewId
        : null) ??
      viewIds.find((id) => matchesOwner(views[id])) ??
      null)
  const workspace = host ? { worktreeId, executionHostId: host } : pane.workspace
  const selectedPane = preferredPane ?? pane
  const selectedPaneViewIds = preferredPane ? preferredPane.viewIds : viewIds
  const selectedPaneWorkspace =
    preferredPane && preferredView
      ? { worktreeId: preferredView.worktreeId, executionHostId: preferredView.executionHostId }
      : workspace
  const activePaneId = selectedPane.id
  const nextPane = {
    ...selectedPane,
    viewIds: selectedPaneViewIds,
    selectedViewId: preferredPane ? preferredView!.id : selectedViewId,
    workspace: selectedPaneWorkspace
  }
  const paneUnchanged =
    selectedPaneViewIds.length === selectedPane.viewIds.length &&
    selectedPaneViewIds.every((id, index) => selectedPane.viewIds[index] === id) &&
    nextPane.selectedViewId === selectedPane.selectedViewId &&
    nextPane.workspace?.worktreeId === selectedPane.workspace?.worktreeId &&
    nextPane.workspace?.executionHostId === selectedPane.workspace?.executionHostId
  const expandedPaneId = layout.expandedPaneId
    ? preferredPane?.id
      ? selectedPane.id
      : layout.expandedPaneId
    : null
  if (
    duplicateViewIds.size === 0 &&
    activePaneId === layout.activePaneId &&
    expandedPaneId === layout.expandedPaneId &&
    paneUnchanged
  ) {
    return layout
  }
  const panes = { ...normalizedPanes }
  if (selectedPane.id !== pane.id && viewIds.length !== pane.viewIds.length) {
    panes[pane.id] = { ...pane, viewIds }
  }
  panes[selectedPane.id] = nextPane
  return {
    ...layout,
    activePaneId,
    expandedPaneId,
    views,
    panes
  }
}

export function workspaceTabKey(
  view: Pick<WorkspaceView, 'worktreeId' | 'executionHostId' | 'tabId'>
): string {
  return JSON.stringify([view.executionHostId, view.worktreeId, view.tabId])
}

export function sameWorkspaceSession(first: WorkspaceView, second: WorkspaceView): boolean {
  return workspaceSessionKey(first) === workspaceSessionKey(second)
}

export function workspaceSessionKey(
  view: Pick<WorkspaceView, 'worktreeId' | 'executionHostId' | 'contentType' | 'entityId'>
): string {
  return JSON.stringify([view.worktreeId, view.executionHostId, view.contentType, view.entityId])
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
