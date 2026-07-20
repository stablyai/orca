import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { WorkbenchView, WorktreeSplitDirection } from '../../../../shared/types'
import type { WorktreeLayoutPath, WorktreeSplitPlacement } from '../../lib/worktree-layout-tree'
import { collectLeafWorktreeIds } from '../../lib/worktree-layout-tree'
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
  /** Sidebar "open in parallel": seed a view from the current worktree if none
   *  exists, then split the focused pane with `worktreeId` (or focus it if it is
   *  already visible). */
  openWorktreeInParallel: (worktreeId: string, direction: WorktreeSplitDirection) => void
  retargetFocusedWorkbenchPane: (newWorktreeId: string) => void
  setActiveWorkbenchPaneRatio: (path: WorktreeLayoutPath, ratio: number) => void
  focusActiveWorkbenchPane: (worktreeId: string) => void
  /** Flip the parallel layout orientation (side-by-side <-> stacked). */
  flipWorkbenchOrientation: () => void
  /** Flip only the split that contains this worktree's pane (per-pane control). */
  togglePaneSplitDirection: (worktreeId: string) => void
  /** Point the active view at the parallel set containing the active worktree and
   *  focus it there — switches sets when the active worktree changes. */
  syncWorkbenchToActiveWorktree: () => void
  /** Drag-rearrange (§6.6 B): move fromWorktreeId's pane beside targetWorktreeId. */
  moveWorktreePaneBeside: (
    fromWorktreeId: string,
    targetWorktreeId: string,
    direction: WorktreeSplitDirection,
    placement?: WorktreeSplitPlacement
  ) => void
  /** Drag-split (§6.6 A): add newWorktreeId beside targetWorktreeId's pane. */
  splitWorktreePaneBeside: (
    targetWorktreeId: string,
    direction: WorktreeSplitDirection,
    newWorktreeId: string,
    placement?: WorktreeSplitPlacement
  ) => void
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
      const collapsedViewId = get().activeWorkbenchViewId
      set((s) => viewModel.closeActivePane(s, worktreeId))
      // Move the active worktree to the surviving focused pane first...
      syncActiveWorktree()
      // ...then, if THIS set collapsed below 2 panes, drop only that one view —
      // other parallel sets stay. activeWorktreeId already points at the
      // survivor, so the membership gate shows it as a normal single view (no
      // surprising jump into another set).
      if (collapsedViewId && viewModel.getVisibleWorktreeIds(get()).length < 2) {
        set((s) => viewModel.closeWorkbenchView(s, collapsedViewId))
      }
    },

    openWorktreeInParallel: (worktreeId, direction) => {
      const state = get()
      const current = state.activeWorktreeId
      if (!current || current === worktreeId) {
        // Nothing to pair with yet — just activate the clicked worktree.
        get().setActiveWorktree(worktreeId)
        return
      }
      // Target the parallel set that CONTAINS the current worktree — not whatever
      // view is flagged active. If current isn't already in a >= 2-pane set, start
      // a NEW set from it (appended, keeping other sets). Either way the clicked
      // worktree is split in beside `current`, so parallel pairs what's focused.
      const currentSet = viewModel.findViewContaining(state, current)
      if (currentSet && collectLeafWorktreeIds(currentSet.layout).length >= 2) {
        set({ activeWorkbenchViewId: currentSet.id })
      } else {
        set((s) => viewModel.createSingleLeafView(s, crypto.randomUUID(), current))
      }
      set((s) => viewModel.splitActivePane(s, current, direction, worktreeId))
      // splitActivePane no-ops when the worktree is already visible; focus it then.
      set((s) => viewModel.focusActivePane(s, worktreeId))
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

    flipWorkbenchOrientation: () => {
      set((s) => viewModel.flipActiveViewOrientation(s))
    },

    togglePaneSplitDirection: (worktreeId) => {
      set((s) => viewModel.togglePaneSplitDirection(s, worktreeId))
    },

    syncWorkbenchToActiveWorktree: () => {
      const wt = get().activeWorktreeId
      if (wt == null) {
        return
      }
      const view = viewModel.findViewContaining(get(), wt)
      if (!view) {
        return
      }
      // Activate the containing set WITHOUT going through setActiveWorktree (no
      // focus jump), then mark that worktree as the set's focused pane.
      if (get().activeWorkbenchViewId !== view.id) {
        set({ activeWorkbenchViewId: view.id })
      }
      set((s) => viewModel.focusActivePane(s, wt))
    },

    moveWorktreePaneBeside: (fromWorktreeId, targetWorktreeId, direction, placement) => {
      const containingSet = viewModel.findViewContaining(get(), targetWorktreeId)
      if (containingSet && get().activeWorkbenchViewId !== containingSet.id) {
        set({ activeWorkbenchViewId: containingSet.id })
      }
      set((s) =>
        viewModel.moveActivePane(s, fromWorktreeId, targetWorktreeId, direction, placement)
      )
      set((s) => viewModel.focusActivePane(s, fromWorktreeId))
      syncActiveWorktree()
    },

    splitWorktreePaneBeside: (targetWorktreeId, direction, newWorktreeId, placement) => {
      const containingSet = viewModel.findViewContaining(get(), targetWorktreeId)
      if (containingSet) {
        if (get().activeWorkbenchViewId !== containingSet.id) {
          set({ activeWorkbenchViewId: containingSet.id })
        }
      } else {
        // Target is a lone worktree — seed a set from it, then split beside it.
        set((s) => viewModel.createSingleLeafView(s, crypto.randomUUID(), targetWorktreeId))
      }
      set((s) =>
        viewModel.splitActivePane(s, targetWorktreeId, direction, newWorktreeId, placement)
      )
      set((s) => viewModel.focusActivePane(s, newWorktreeId))
      syncActiveWorktree()
    },

    setWorkbenchTabsPinned: (pinned) => {
      set({ workbenchTabsPinned: pinned })
    }
  }
}
