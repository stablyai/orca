import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { WorkbenchView, WorktreeSplitDirection } from '../../../../shared/types'
import type { WorktreeLayoutPath, WorktreeSplitPlacement } from '../../lib/worktree-layout-tree'
import * as viewModel from '../../lib/workbench-view-model'

// Thin Zustand glue over the pure workbench-view model. Owns id generation and
// mirrors the focused pane onto activeWorktreeId; all list/layout logic lives in
// workbench-view-model (unit-tested). Wiring into the workbench render seam and
// session hydration lands in later commits — until then this slice is inert
// (workbenchViews starts empty, so getVisibleWorktreeIds is empty and the render
// gate behaves exactly as before).

export type WorkbenchViewsSlice = {
  workbenchViews: WorkbenchView[]
  activeWorkbenchViewId: string | null
  /** View → Show Workbench Tabs: force the super-tab strip on for a lone view. */
  workbenchTabsPinned: boolean

  createWorkbenchView: (worktreeId: string, options?: { activate?: boolean }) => string
  activateWorkbenchView: (viewId: string) => void
  closeWorkbenchView: (viewId: string) => void
  renameWorkbenchView: (viewId: string, title: string) => void
  moveWorkbenchView: (viewId: string, toIndex: number) => void
  splitActiveWorkbenchPane: (
    targetWorktreeId: string,
    direction: WorktreeSplitDirection,
    newWorktreeId: string,
    placement?: WorktreeSplitPlacement
  ) => void
  closeActiveWorkbenchPane: (worktreeId: string) => void
  retargetFocusedWorkbenchPane: (newWorktreeId: string) => void
  setActiveWorkbenchPaneRatio: (path: WorktreeLayoutPath, ratio: number) => void
  focusActiveWorkbenchPane: (worktreeId: string) => void
  setWorkbenchTabsPinned: (pinned: boolean) => void
}

export const createWorkbenchViewsSlice: StateCreator<AppState, [], [], WorkbenchViewsSlice> = (
  set,
  get
) => {
  // Why: the focused pane is the single source of truth for "active worktree",
  // so every focus-changing view mutation mirrors it onto activeWorktreeId — the
  // key the ~40 per-worktree maps, the sidebar highlight, and the right panel
  // all read. Keeps existing consumers working with no keying changes.
  const syncActiveWorktree = (): void => {
    const focused = viewModel.getActiveWorkbenchView(get())?.focusedWorktreeId
    if (focused && focused !== get().activeWorktreeId) {
      get().setActiveWorktree(focused)
    }
  }

  return {
    workbenchViews: [],
    activeWorkbenchViewId: null,
    workbenchTabsPinned: false,

    createWorkbenchView: (worktreeId, options) => {
      const viewId = crypto.randomUUID()
      set((s) => viewModel.createSingleLeafView(s, viewId, worktreeId, options))
      if (options?.activate !== false) {
        syncActiveWorktree()
      }
      return viewId
    },

    activateWorkbenchView: (viewId) => {
      set((s) => viewModel.activateWorkbenchView(s, viewId))
      syncActiveWorktree()
    },

    closeWorkbenchView: (viewId) => {
      set((s) => viewModel.closeWorkbenchView(s, viewId))
      syncActiveWorktree()
    },

    renameWorkbenchView: (viewId, title) => {
      set((s) => viewModel.renameWorkbenchView(s, viewId, title))
    },

    moveWorkbenchView: (viewId, toIndex) => {
      set((s) => viewModel.moveWorkbenchView(s, viewId, toIndex))
    },

    splitActiveWorkbenchPane: (targetWorktreeId, direction, newWorktreeId, placement) => {
      set((s) =>
        viewModel.splitActivePane(s, targetWorktreeId, direction, newWorktreeId, placement)
      )
      syncActiveWorktree()
    },

    closeActiveWorkbenchPane: (worktreeId) => {
      set((s) => viewModel.closeActivePane(s, worktreeId))
      syncActiveWorktree()
    },

    retargetFocusedWorkbenchPane: (newWorktreeId) => {
      set((s) => viewModel.retargetFocusedPane(s, newWorktreeId))
      syncActiveWorktree()
    },

    setActiveWorkbenchPaneRatio: (path, ratio) => {
      set((s) => viewModel.setActivePaneRatio(s, path, ratio))
    },

    focusActiveWorkbenchPane: (worktreeId) => {
      set((s) => viewModel.focusActivePane(s, worktreeId))
      syncActiveWorktree()
    },

    setWorkbenchTabsPinned: (pinned) => {
      set({ workbenchTabsPinned: pinned })
    }
  }
}
