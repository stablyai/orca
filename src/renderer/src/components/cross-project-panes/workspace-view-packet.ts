import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type {
  WindowPaneLayout,
  WorkspaceView,
  WorkspacePaneDropTarget
} from '../../../../shared/window-pane-types'
import { moveWorkspaceView } from '@/store/slices/window-pane-move'
import { toVisibleTabType, type Tab } from '../../../../shared/tab-types'
import { toHostSessionTabId } from '../../../../shared/terminal-surface-id'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { resolveHostSessionTabIdForWebSessionTab } from '@/runtime/web-session-tabs-sync'
import {
  tabExecutionHost,
  resolveWorkspaceView,
  paneSelectionPatch,
  workspaceTabKey
} from '@/store/slices/window-pane-selection'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildSplitNode, replaceLeaf } from '@/store/slices/tabs/tabs-layout'
import {
  captureEditorView,
  restoreTransferredEditorView,
  type EditorViewTransfer
} from '../editor/editor-view-transfer'
import { getDiskBaselineSignature } from '../editor/diff-content-signature'

export type WorkspaceViewPacket = {
  views: {
    view: WorkspaceView
    owner: string
    session: string
    paneId: string
    selected: boolean
    file?: OpenFile
    draft?: string
    editorView?: EditorViewTransfer
    editorMode?: AppState['editorViewMode'][string]
  }[]
}

export function sessionIdentity(state: AppState, tab: Tab): string {
  if (toVisibleTabType(tab.contentType) === 'editor') {
    const file = state.openFiles.find((file) => file.id === tab.entityId)
    return JSON.stringify([file?.filePath, file?.mode, file?.diffSource])
  }
  const host = parseExecutionHostId(tabExecutionHost(state, tab))
  if (host?.kind === 'runtime') {
    const mapped = resolveHostSessionTabIdForWebSessionTab(state, {
      environmentId: host.environmentId,
      worktreeId: tab.worktreeId,
      tabId: tab.id
    })
    if (mapped) {
      return mapped
    }
  }
  return toHostSessionTabId(tab.contentType === 'terminal' ? tab.entityId : tab.id)
}

export function captureWorkspaceViews(
  state: AppState,
  ids: string[],
  hosts: Record<string, string>
): WorkspaceViewPacket {
  const layout = state.windowPaneLayout
  if (!layout || !ids.length) {
    throw new Error('No views to transfer')
  }
  return {
    views: ids.map((id) => {
      const view = layout.views[id]
      const tab = view && resolveWorkspaceView(state, view)
      const pane = Object.values(layout.panes).find((pane) => pane.viewIds.includes(id))
      if (!tab || !pane || !hosts[view.executionHostId]) {
        throw new Error('Session unavailable')
      }
      const file =
        toVisibleTabType(view.contentType) === 'editor'
          ? state.openFiles.find((file) => file.id === view.entityId)
          : undefined
      const editorView = file
        ? (captureEditorView(view.id) ?? captureEditorView(view.tabId))
        : undefined
      const draft = editorView?.text ?? (file ? state.editorDrafts[file.id] : undefined)
      const isDirty =
        file &&
        (file.isDirty ||
          state.editorDrafts[file.id] !== undefined ||
          (draft !== undefined &&
            file.lastKnownDiskSignature !== undefined &&
            getDiskBaselineSignature(draft) !== file.lastKnownDiskSignature))
      return {
        view,
        owner: hosts[view.executionHostId],
        session: sessionIdentity(state, tab),
        paneId: pane.id,
        selected: pane.selectedViewId === id,
        ...(file
          ? {
              file: { ...file, isDirty: !!isDirty },
              draft,
              editorView,
              editorMode: state.editorViewMode[file.id]
            }
          : {})
      }
    })
  }
}

export function findWorkspaceViewSession(
  state: AppState,
  entry: Pick<WorkspaceViewPacket['views'][number], 'view' | 'owner' | 'session'>,
  hosts: Record<string, string>
): Tab | undefined {
  return state.unifiedTabsByWorktree[entry.view.worktreeId]?.find(
    (tab) =>
      hosts[tabExecutionHost(state, tab) ?? ''] === entry.owner &&
      tab.contentType === entry.view.contentType &&
      sessionIdentity(state, tab) === entry.session
  )
}

export function importWorkspaceViews(
  state: AppState,
  packet: WorkspaceViewPacket,
  mode: 'tabs' | 'panes',
  hosts: Record<string, string>,
  target?: WorkspacePaneDropTarget
): Partial<AppState> {
  if (target && !state.windowPaneLayout?.panes[target.paneId]) {
    throw new Error('Destination pane unavailable')
  }
  const resolved = packet.views.map((entry) => {
    const tab = findWorkspaceViewSession(state, entry, hosts)
    if (!tab) {
      throw new Error('Session unavailable')
    }
    if (entry.file) {
      const file = state.openFiles.find((file) => file.id === tab.entityId)
      if (!file) {
        throw new Error('Session unavailable')
      }
      const viewIds = Object.values(state.windowPaneLayout?.views ?? {})
        .filter((view) => view.tabId === tab.id)
        .map((view) => view.id)
      for (const id of [...viewIds, tab.id]) {
        const current = captureEditorView(id)
        if (
          current &&
          current.text !== entry.draft &&
          (file.lastKnownDiskSignature === undefined ||
            getDiskBaselineSignature(current.text) !== file.lastKnownDiskSignature)
        ) {
          throw new Error('Unsaved destination conflicts with this view')
        }
      }
    }
    if (
      entry.file &&
      Object.hasOwn(state.editorDrafts, tab.entityId) &&
      state.editorDrafts[tab.entityId] !== entry.draft
    ) {
      throw new Error('Unsaved destination conflicts with this view')
    }
    return { entry, tab }
  })
  const initialId = createBrowserUuid()
  const initial: WindowPaneLayout = state.windowPaneLayout ?? {
    version: 1,
    root: { type: 'leaf', groupId: initialId },
    activePaneId: initialId,
    expandedPaneId: null,
    panes: { [initialId]: { id: initialId, viewIds: [], selectedViewId: null } },
    views: {}
  }
  const layout: WindowPaneLayout = {
    ...initial,
    expandedPaneId: null,
    views: { ...initial.views },
    panes: Object.fromEntries(
      Object.entries(initial.panes).map(([id, pane]) => [
        id,
        { ...pane, viewIds: [...pane.viewIds] }
      ])
    )
  }
  const paneIds = new Map<string, string>()
  const editorDrafts = { ...state.editorDrafts }
  const editorViewMode = { ...state.editorViewMode }
  const openFiles = [...state.openFiles]
  for (const { entry, tab } of resolved) {
    let paneId = layout.activePaneId
    if (mode === 'panes') {
      paneId = paneIds.get(entry.paneId) ?? createBrowserUuid()
      if (!paneIds.has(entry.paneId)) {
        paneIds.set(entry.paneId, paneId)
        layout.root = replaceLeaf(
          layout.root,
          layout.activePaneId,
          buildSplitNode(layout.activePaneId, paneId, 'horizontal', 'second')
        )
        layout.panes[paneId] = { id: paneId, viewIds: [], selectedViewId: null }
      }
    }
    const id = createBrowserUuid()
    layout.views[id] = {
      ...entry.view,
      id,
      controlPending: true,
      tabId: tab.id,
      entityId: tab.entityId,
      executionHostId: tabExecutionHost(state, tab)!
    }
    if (entry.editorView) {
      restoreTransferredEditorView(id, entry.editorView)
    }
    layout.panes[paneId].viewIds.push(id)
    layout.panes[paneId].dismissedTabKeys = layout.panes[paneId].dismissedTabKeys?.filter(
      (key) => key !== workspaceTabKey(layout.views[id])
    )
    if (entry.selected || !layout.panes[paneId].selectedViewId) {
      layout.panes[paneId].selectedViewId = id
    }
    layout.panes[paneId].workspace = layout.views[id]
    if (entry.file) {
      if (entry.editorMode) {
        editorViewMode[tab.entityId] = entry.editorMode
      }
      const index = openFiles.findIndex((file) => file.id === tab.entityId)
      if (index === -1) {
        throw new Error('Session unavailable')
      }
      openFiles[index] = {
        ...openFiles[index],
        isDirty: entry.file.isDirty,
        lastKnownDiskSignature: entry.file.lastKnownDiskSignature
      }
      if (entry.draft !== undefined) {
        editorDrafts[tab.entityId] = entry.draft
      }
    }
  }
  if (mode === 'panes' && paneIds.size) {
    layout.activePaneId = [...paneIds.values()].at(-1)!
  }
  let patch: Partial<AppState> = {
    windowPaneLayout: layout,
    editorDrafts,
    editorViewMode,
    openFiles,
    activeView: 'terminal',
    ...paneSelectionPatch(
      state,
      layout.views[layout.panes[layout.activePaneId].selectedViewId ?? '']
    )
  }
  if (target) {
    for (const id of Object.keys(layout.views).filter((id) => !initial.views[id])) {
      patch = { ...patch, ...moveWorkspaceView({ ...state, ...patch }, id, target) }
      target = {
        paneId: patch.windowPaneLayout!.activePaneId,
        zone: 'center',
        beforeViewId: target.beforeViewId
      }
    }
    const next = patch.windowPaneLayout!
    for (const [id, pane] of Object.entries(initial.panes)) {
      if (JSON.stringify(next.panes[id]?.viewIds) === JSON.stringify(pane.viewIds)) {
        next.panes[id] = pane
      }
    }
  }
  return patch
}
