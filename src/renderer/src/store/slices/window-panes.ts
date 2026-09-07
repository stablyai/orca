import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  WindowPaneLayout,
  WorkspacePaneDropTarget
} from '../../../../shared/window-pane-types'
import { moveWorkspaceView } from './window-pane-move'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  buildSplitNode,
  replaceLeaf,
  collapseGroupLayout,
  updateSplitRatio
} from './tabs/tabs-layout'
import {
  appendWorkspaceViews,
  paneSelectionPatch,
  resolveWorkspaceView,
  workspaceTabKey
} from './window-pane-selection'
import { duplicateWorkspaceView } from './window-pane-duplicate'
import {
  recordWindowPaneChange,
  restoreWorkspaceLayout,
  type WindowPaneHistory
} from './window-pane-history'

export type WindowPanesSlice = WindowPaneHistory & {
  windowPaneLayout: WindowPaneLayout | null
  initializeWindowPanes: () => void
  synchronizeWindowPaneSelection: (unplacedOnly?: boolean) => void
  focusWindowPane: (paneId: string, viewId?: string) => void
  splitWindowPane: (paneId: string, direction: 'horizontal' | 'vertical') => void
  expandWindowPane: (paneId: string) => void
  closeWindowPane: (paneId: string) => void
  closeWorkspaceView: (paneId: string, viewId: string, history?: boolean) => void
  setWindowPaneRatio: (path: string, ratio: number) => void
  openAnotherWorkspaceView: (paneId: string) => void
  moveWorkspaceView: (viewId: string, target: WorkspacePaneDropTarget) => void
}

export const createWindowPanesSlice: StateCreator<AppState, [], [], WindowPanesSlice> = (
  set,
  get
) => {
  const change = (recipe: (state: AppState) => Partial<AppState>, closed = false, history = true) =>
    set((state) => (history ? recordWindowPaneChange(state, recipe(state), closed) : recipe(state)))
  return {
    workspaceLayoutHistory: [],
    closedWorkspaceViews: [],
    undoWorkspaceLayoutChange: () => set((state) => restoreWorkspaceLayout(state, false)),
    reopenClosedWorkspaceView: () => set((state) => restoreWorkspaceLayout(state, true)),
    windowPaneLayout: null,
    moveWorkspaceView: (viewId, target) =>
      change((state) => moveWorkspaceView(state, viewId, target)),
    openAnotherWorkspaceView: (paneId) => change((state) => duplicateWorkspaceView(state, paneId)),
    initializeWindowPanes: () => {
      if (get().windowPaneLayout || !get().activeWorktreeId) {
        return
      }
      const id = createBrowserUuid()
      set((state) => ({
        windowPaneLayout: appendWorkspaceViews(state, {
          version: 1,
          root: { type: 'leaf', groupId: id },
          activePaneId: id,
          expandedPaneId: null,
          panes: { [id]: { id, viewIds: [], selectedViewId: null } },
          views: {}
        })
      }))
    },
    synchronizeWindowPaneSelection: (unplacedOnly = false) =>
      set((state) => {
        if (!state.windowPaneLayout) {
          return state
        }
        const next = appendWorkspaceViews(state, state.windowPaneLayout, unplacedOnly)
        const pane = next.panes[next.activePaneId]
        const view = next.views[pane.selectedViewId ?? '']
        const tab = view && resolveWorkspaceView(state, view)
        const projection = paneSelectionPatch(state, view, pane.workspace)
        const selectionMatches =
          Object.entries(projection).every(
            ([key, value]) =>
              key === 'groupsByWorktree' ||
              key === 'activeGroupIdByWorktree' ||
              state[key as keyof AppState] === value
          ) &&
          (!tab || state.getActiveTab(tab.worktreeId)?.id === tab.id)
        if (next === state.windowPaneLayout && selectionMatches) {
          return state
        }
        return {
          ...projection,
          windowPaneLayout: next === state.windowPaneLayout ? { ...next } : next
        }
      }),
    focusWindowPane: (paneId, viewId) =>
      set((state) => {
        const layout = state.windowPaneLayout
        const pane = layout?.panes[paneId]
        if (!layout || !pane || (viewId && !pane.viewIds.includes(viewId))) {
          return state
        }
        const selectedViewId = viewId ?? pane.selectedViewId
        if (
          layout.activePaneId === paneId &&
          selectedViewId === pane.selectedViewId &&
          (!layout.expandedPaneId || layout.expandedPaneId === paneId)
        ) {
          return state
        }
        return {
          windowPaneLayout: {
            ...layout,
            activePaneId: paneId,
            expandedPaneId: layout.expandedPaneId ? paneId : null,
            panes: { ...layout.panes, [paneId]: { ...pane, selectedViewId } }
          },
          ...paneSelectionPatch(
            state,
            selectedViewId ? layout.views[selectedViewId] : undefined,
            pane.workspace
          )
        }
      }),
    splitWindowPane: (paneId, direction) =>
      change((state) => {
        const layout = state.windowPaneLayout
        const pane = layout?.panes[paneId]
        if (!layout || !pane) {
          return state
        }
        const id = createBrowserUuid()
        const viewIds = pane.viewIds.filter((viewId) => viewId !== pane.selectedViewId)
        const selectedOwner = layout.views[pane.selectedViewId ?? '']?.worktreeId
        const nextSelectedViewId =
          viewIds.find((viewId) => layout.views[viewId].worktreeId === selectedOwner) ??
          viewIds.at(-1) ??
          null
        return {
          windowPaneLayout: {
            ...layout,
            root: replaceLeaf(layout.root, paneId, buildSplitNode(paneId, id, direction, 'second')),
            activePaneId: id,
            expandedPaneId: null,
            panes: {
              ...layout.panes,
              [paneId]: { ...pane, viewIds, selectedViewId: nextSelectedViewId },
              [id]: {
                id,
                viewIds: pane.selectedViewId ? [pane.selectedViewId] : [],
                selectedViewId: pane.selectedViewId,
                workspace: pane.workspace
              }
            }
          }
        }
      }),
    expandWindowPane: (paneId) =>
      change((state) => {
        const layout = state.windowPaneLayout
        if (!layout?.panes[paneId]) {
          return state
        }
        return {
          windowPaneLayout: {
            ...layout,
            expandedPaneId: layout.expandedPaneId === paneId ? null : paneId
          }
        }
      }),
    closeWindowPane: (paneId) =>
      change((state) => {
        const layout = state.windowPaneLayout
        if (!layout?.panes[paneId] || Object.keys(layout.panes).length === 1) {
          return state
        }
        const { [paneId]: removed, ...panes } = layout.panes
        const collapsed = collapseGroupLayout(
          { window: layout.root },
          { window: layout.activePaneId },
          'window',
          paneId
        )
        const activePaneId =
          layout.activePaneId === paneId
            ? collapsed.activeGroupIdByWorktree.window
            : layout.activePaneId
        const views = { ...layout.views }
        for (const id of removed.viewIds) {
          delete views[id]
        }
        return {
          windowPaneLayout: {
            ...layout,
            panes,
            views,
            root: collapsed.layoutByWorktree.window,
            activePaneId,
            expandedPaneId: null
          },
          ...paneSelectionPatch(
            state,
            views[panes[activePaneId].selectedViewId ?? ''],
            panes[activePaneId].workspace
          )
        }
      }, true),
    closeWorkspaceView: (paneId, viewId, history = true) =>
      change(
        (state) => {
          const layout = state.windowPaneLayout
          const pane = layout?.panes[paneId]
          if (!layout || !pane?.viewIds.includes(viewId)) {
            return state
          }
          const viewIds = pane.viewIds.filter((id) => id !== viewId)
          const selectedViewId =
            pane.selectedViewId === viewId ? (viewIds.at(-1) ?? null) : pane.selectedViewId
          const views = { ...layout.views }
          const dismissedTabKeys = [
            ...(pane.dismissedTabKeys ?? []),
            workspaceTabKey(views[viewId])
          ]
          delete views[viewId]
          return {
            windowPaneLayout: {
              ...layout,
              views,
              panes: {
                ...layout.panes,
                [paneId]: { ...pane, viewIds, selectedViewId, dismissedTabKeys }
              }
            },
            ...(layout.activePaneId === paneId
              ? paneSelectionPatch(state, views[selectedViewId ?? ''], pane.workspace)
              : {})
          }
        },
        true,
        history
      ),
    setWindowPaneRatio: (path, ratio) =>
      change((state) =>
        state.windowPaneLayout
          ? {
              windowPaneLayout: {
                ...state.windowPaneLayout,
                root: updateSplitRatio(
                  state.windowPaneLayout.root,
                  path ? path.split('.') : [],
                  ratio
                )
              }
            }
          : state
      )
  }
}
