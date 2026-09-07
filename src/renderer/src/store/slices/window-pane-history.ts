import type { AppState } from '../types'
import type { WindowPaneLayout } from '../../../../shared/window-pane-types'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { paneSelectionPatch } from './window-pane-selection'
import { collapseGroupLayout } from './tabs/tabs-layout'
import { restoreMissingPane } from './window-pane-history-tree'
import { captureEditorView } from '@/components/editor/editor-view-transfer'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'

export type WindowPaneChange = {
  before: WindowPaneLayout
  after: WindowPaneLayout
  closed: boolean
  transferId?: string
  editorBaselines: Record<string, { draft?: string; text?: string; disk?: string }>
}
export type WindowPaneHistory = {
  workspaceLayoutHistory: WindowPaneChange[]
  closedWorkspaceViews: WindowPaneChange[]
  undoWorkspaceLayoutChange: () => void
  reopenClosedWorkspaceView: () => void
}

export function recordWindowPaneChange(
  state: AppState,
  patch: Partial<AppState>,
  closed = false
): Partial<AppState> {
  const after = patch.windowPaneLayout
  if (!after || state.windowPaneLayout === after) {
    return patch
  }
  const paneId = after.activePaneId
  const before = state.windowPaneLayout ?? {
    ...after,
    root: { type: 'leaf' as const, groupId: paneId },
    panes: { [paneId]: { id: paneId, viewIds: [], selectedViewId: null } },
    views: {}
  }
  const next = { ...state, ...patch }
  const editorBaselines = Object.fromEntries(
    Object.values(after.views)
      .filter((view) => !before.views[view.id] && toVisibleTabType(view.contentType) === 'editor')
      .map((view) => [
        view.id,
        {
          draft: next.editorDrafts[view.entityId],
          text: captureEditorView(view.id)?.text ?? captureEditorView(view.tabId)?.text,
          disk: next.openFiles.find((file) => file.id === view.entityId)?.lastKnownDiskSignature
        }
      ])
  )
  const change = { before, after, closed, editorBaselines }
  return {
    ...patch,
    workspaceLayoutHistory: [...state.workspaceLayoutHistory.slice(-19), change],
    ...(closed ? { closedWorkspaceViews: [...state.closedWorkspaceViews.slice(-19), change] } : {})
  }
}

function restoreOrder(current: string[], before: string[], after: string[]): string[] {
  const changed = new Set(
    [...before, ...after].filter((id) => before.includes(id) !== after.includes(id))
  )
  const result = current.filter((id) => !changed.has(id))
  for (const id of before) {
    if (!changed.has(id)) {
      continue
    }
    result.splice(Math.min(before.indexOf(id), result.length), 0, id)
  }
  if (!changed.size && JSON.stringify(current) === JSON.stringify(after)) {
    return before
  }
  return result
}

function restoreBranch(
  current: TabGroupLayoutNode,
  before: TabGroupLayoutNode,
  after: TabGroupLayoutNode
): TabGroupLayoutNode {
  if (JSON.stringify(current) === JSON.stringify(after)) {
    return before
  }
  if (JSON.stringify(before) === JSON.stringify(after) || current.type === 'leaf') {
    return current
  }
  return {
    ...current,
    first: restoreBranch(current.first, before, after),
    second: restoreBranch(current.second, before, after)
  }
}

export function reverseWindowPaneChange(
  state: AppState,
  change: WindowPaneChange
): Partial<AppState> {
  const current = state.windowPaneLayout
  if (!current) {
    return {}
  }
  const { before, after } = change
  const panes = Object.fromEntries(
    Object.entries(current.panes).map(([id, pane]) => [id, { ...pane, viewIds: [...pane.viewIds] }])
  )
  const views = { ...current.views }
  const retained = new Set<string>()
  for (const id of Object.keys(after.views)) {
    if (!before.views[id]) {
      const baseline = change.editorBaselines[id]
      const view = views[id]
      const live = captureEditorView(id)
      if (
        view &&
        baseline &&
        (state.editorDrafts[view.entityId] !== baseline.draft ||
          (live &&
            (baseline.text !== undefined
              ? live.text !== baseline.text
              : baseline.draft !== undefined
                ? live.text !== baseline.draft
                : getDiskBaselineSignature(live.text) !== baseline.disk)))
      ) {
        retained.add(id)
        continue
      }
      delete views[id]
      for (const pane of Object.values(panes)) {
        pane.viewIds = pane.viewIds.filter((entry) => entry !== id)
      }
    }
  }
  for (const [id, view] of Object.entries(before.views)) {
    if (!after.views[id] && !views[id]) {
      views[id] = view
    }
  }
  let root = restoreBranch(current.root, before.root, after.root)
  for (const [id, pane] of Object.entries(before.panes)) {
    const previous = after.panes[id]
    if (!panes[id]) {
      panes[id] = { ...pane, viewIds: [...pane.viewIds] }
      root = restoreMissingPane(root, before.root, id)
    } else if (previous) {
      const now = panes[id]
      now.viewIds = restoreOrder(now.viewIds, pane.viewIds, previous.viewIds).filter(
        (viewId) => !!views[viewId]
      )
      now.viewIds.push(
        ...current.panes[id].viewIds.filter(
          (viewId) => retained.has(viewId) && !now.viewIds.includes(viewId)
        )
      )
      if (JSON.stringify(pane.dismissedTabKeys) !== JSON.stringify(previous.dismissedTabKeys)) {
        now.dismissedTabKeys = restoreOrder(
          now.dismissedTabKeys ?? [],
          pane.dismissedTabKeys ?? [],
          previous.dismissedTabKeys ?? []
        )
        if (!pane.dismissedTabKeys && !now.dismissedTabKeys.length) {
          delete now.dismissedTabKeys
        }
      }
      if (now.selectedViewId === previous.selectedViewId) {
        now.selectedViewId = pane.selectedViewId
      }
      if (JSON.stringify(now.workspace) === JSON.stringify(previous.workspace)) {
        now.workspace = pane.workspace
      }
    }
  }
  for (const id of Object.keys(after.panes)) {
    if (before.panes[id] || !panes[id]) {
      continue
    }
    const destination =
      panes[before.activePaneId] ?? Object.values(panes).find((pane) => pane.id !== id)!
    destination.viewIds = [...new Set([...destination.viewIds, ...panes[id].viewIds])]
    delete panes[id]
    root = collapseGroupLayout({ window: root }, { window: destination.id }, 'window', id)
      .layoutByWorktree.window
  }
  const assigned = new Set<string>()
  for (const pane of Object.values(panes)) {
    pane.viewIds = pane.viewIds.filter((id) => {
      if (!views[id] || assigned.has(id)) {
        return false
      }
      assigned.add(id)
      return true
    })
    if (!pane.viewIds.includes(pane.selectedViewId ?? '')) {
      pane.selectedViewId = pane.viewIds.at(-1) ?? null
    }
  }
  const activePaneId =
    current.activePaneId === after.activePaneId || !panes[current.activePaneId]
      ? before.activePaneId
      : current.activePaneId
  const expandedPaneId =
    current.expandedPaneId === after.expandedPaneId ? before.expandedPaneId : current.expandedPaneId
  const layout = {
    ...current,
    root,
    panes,
    views,
    activePaneId,
    expandedPaneId: expandedPaneId && panes[expandedPaneId] ? expandedPaneId : null
  }
  const pane = panes[activePaneId]
  return {
    windowPaneLayout: layout,
    ...paneSelectionPatch(state, views[pane.selectedViewId ?? ''], pane.workspace)
  }
}

export function restoreWorkspaceLayout(state: AppState, closed: boolean): Partial<AppState> {
  const change = (closed ? state.closedWorkspaceViews : state.workspaceLayoutHistory).at(-1)
  if (!change) {
    return {}
  }
  return {
    ...reverseWindowPaneChange(state, change),
    workspaceLayoutHistory: state.workspaceLayoutHistory.filter((entry) => entry !== change),
    closedWorkspaceViews: state.closedWorkspaceViews.filter((entry) => entry !== change)
  }
}
