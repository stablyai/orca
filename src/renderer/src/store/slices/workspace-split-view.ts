import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { WorkspacePaneNode } from '../../../../shared/types'
import { findWorktreeById } from './worktree-helpers'
import {
  MAX_WORKSPACE_SPLIT_PANES,
  bumpWorkspaceSplitAnchorMru,
  clampWorkspaceSplitRatio,
  collectPaneIds,
  normalizeWorkspaceSplitAnchorKeys,
  pruneWorkspaceSplitState,
  removeWorkspacePaneLeaves,
  removeWorktreesFromOtherWorkspaceSplits,
  replaceWorkspacePaneLeaf,
  splitWorkspacePaneLeaf,
  updateWorkspaceSplitRatioAtPath,
  workspaceSplitContainsPane,
  type WorkspacePaneOpenEdge
} from './workspace-split-layout-tree'

// Re-exported so tree helpers keep their historical import path.
export * from './workspace-split-layout-tree'

export type WorkspaceSplitViewSlice = {
  /** Outer split tree of worktree panes currently ON SCREEN; null = classic
   *  single view. Always mirrors workspaceSplitLayoutsByAnchor[activeAnchor]. */
  workspaceSplitLayout: WorkspacePaneNode | null
  /** Saved splits keyed by anchor (the project that was full-screen when the
   *  split was created). Why: a split is an association between projects —
   *  activating a member project restores its split, activating anything else
   *  leaves the split behind intact until a pane is explicitly closed. */
  workspaceSplitLayoutsByAnchor: Record<string, WorkspacePaneNode>
  activeWorkspaceSplitAnchorId: string | null
  /** Anchor ids, most recently shown first — picks the split to restore when
   *  a project belongs to more than one saved split. */
  workspaceSplitAnchorMru: string[]
  /** Temporarily show one pane of the active split full-width. The split
   *  survives underneath; restore brings the grid back untouched. */
  workspaceSplitMaximizedPaneId: string | null
  maximizeWorkspacePane: (worktreeId: string) => void
  restoreWorkspaceSplitPanes: () => void
  /** Add worktreeId next to (or in place of) targetWorktreeId. Defaults:
   *  target = activeWorktreeId, edge = 'right'. Returns false when gated off,
   *  invalid, already visible, or at the pane cap. */
  openWorkspacePane: (
    worktreeId: string,
    opts?: { targetWorktreeId?: string; edge?: WorkspacePaneOpenEdge }
  ) => boolean
  /** Remove a pane from the active split ("send it back"). Dissolves the
   *  saved association below 2 leaves and refocuses a survivor when the
   *  closed pane was the focused one. */
  closeWorkspacePane: (worktreeId: string) => void
  /** Resize the split that directly contains worktreeId's pane as a child. */
  setWorkspaceSplitRatio: (splitPath: readonly ('first' | 'second')[], ratio: number) => void
  /** Purge-path hook: always runs, flag or not, so disabling the feature can
   *  never strand panes pointing at removed worktrees. */
  removeWorktreesFromSplitView: (worktreeIds: readonly string[]) => void
}

export function isSplitViewActive(state: Pick<AppState, 'workspaceSplitLayout'>): boolean {
  return state.workspaceSplitLayout !== null
}

/** Leaves left→right when split, else just the focused worktree. */
export function selectVisibleWorkspacePaneIds(
  state: Pick<AppState, 'activeWorktreeId' | 'workspaceSplitLayout'>
): string[] {
  if (state.workspaceSplitLayout) {
    return collectPaneIds(state.workspaceSplitLayout)
  }
  return state.activeWorktreeId ? [state.activeWorktreeId] : []
}

export const createWorkspaceSplitViewSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceSplitViewSlice
> = (set, get) => ({
  workspaceSplitLayout: null,
  workspaceSplitLayoutsByAnchor: {},
  activeWorkspaceSplitAnchorId: null,
  workspaceSplitAnchorMru: [],
  workspaceSplitMaximizedPaneId: null,

  maximizeWorkspacePane: (worktreeId) => {
    const s = get()
    if (!workspaceSplitContainsPane(s.workspaceSplitLayout, worktreeId)) {
      return
    }
    set({ workspaceSplitMaximizedPaneId: worktreeId })
    // Why: a full-width pane is what the user is working in; focus follows.
    if (s.activeWorktreeId !== worktreeId) {
      get().setActiveWorktree(worktreeId)
    }
  },

  restoreWorkspaceSplitPanes: () => {
    if (get().workspaceSplitMaximizedPaneId !== null) {
      set({ workspaceSplitMaximizedPaneId: null })
    }
  },

  openWorkspacePane: (worktreeId, opts) => {
    const s = get()
    if (s.settings?.experimentalSideBySideWorkspaces !== true) {
      return false
    }
    if (!findWorktreeById(s.worktreesByRepo, worktreeId)) {
      return false
    }
    const layout = s.workspaceSplitLayout
    const edge = opts?.edge ?? 'right'
    const target = opts?.targetWorktreeId ?? s.activeWorktreeId
    if (!target) {
      return false
    }
    // Why: a mutation either edits the on-screen split under its existing
    // anchor, or mints a new association anchored at the current single view.
    const anchorId = layout ? s.activeWorkspaceSplitAnchorId : target
    if (!anchorId) {
      return false
    }
    const commitActiveLayout = (next: WorkspacePaneNode): void => {
      // Why: a project lives in at most one split — pairing it here steals it
      // from any older pairing, which dissolves once it drops below 2 panes.
      const exclusive = removeWorktreesFromOtherWorkspaceSplits(
        s.workspaceSplitLayoutsByAnchor,
        s.workspaceSplitAnchorMru,
        anchorId,
        collectPaneIds(next)
      )
      // Why: a replace-edge can swap the anchor pane itself out; re-key so a
      // future split minted under that worktree's id can't clobber this one.
      const normalized = normalizeWorkspaceSplitAnchorKeys({
        byAnchor: { ...exclusive.byAnchor, [anchorId]: next },
        mru: bumpWorkspaceSplitAnchorMru(exclusive.mru, anchorId),
        activeAnchorId: anchorId
      })
      set({
        workspaceSplitLayout: next,
        activeWorkspaceSplitAnchorId: normalized.activeAnchorId,
        workspaceSplitLayoutsByAnchor: normalized.byAnchor,
        workspaceSplitAnchorMru: normalized.mru,
        // Why: adding/swapping a pane must show the grid so the change is seen.
        workspaceSplitMaximizedPaneId: null
      })
    }
    if (edge === 'replace') {
      if (!layout || !workspaceSplitContainsPane(layout, target) || target === worktreeId) {
        return false
      }
      // Replacing with an already-visible worktree would duplicate its leaf.
      if (workspaceSplitContainsPane(layout, worktreeId)) {
        return false
      }
      commitActiveLayout(replaceWorkspacePaneLeaf(layout, target, worktreeId))
      return true
    }
    if (worktreeId === target && !layout) {
      return false
    }
    if (workspaceSplitContainsPane(layout, worktreeId)) {
      return false
    }
    const base: WorkspacePaneNode = layout ?? { type: 'pane', worktreeId: target }
    if (!workspaceSplitContainsPane(base, target)) {
      return false
    }
    if (collectPaneIds(base).length >= MAX_WORKSPACE_SPLIT_PANES) {
      return false
    }
    commitActiveLayout(splitWorkspacePaneLeaf(base, target, worktreeId, edge))
    return true
  },

  closeWorkspacePane: (worktreeId) => {
    const s = get()
    const layout = s.workspaceSplitLayout
    const anchorId = s.activeWorkspaceSplitAnchorId
    if (!layout || !anchorId || !workspaceSplitContainsPane(layout, worktreeId)) {
      return
    }
    const removed = removeWorkspacePaneLeaves(layout, new Set([worktreeId]))
    const survivorIds = removed ? collectPaneIds(removed) : []
    if (removed && removed.type === 'split') {
      // Why: closing the anchor's own pane leaves a stale key that a future
      // split minted under that id would clobber; re-key to a surviving leaf.
      const normalized = normalizeWorkspaceSplitAnchorKeys({
        byAnchor: { ...s.workspaceSplitLayoutsByAnchor, [anchorId]: removed },
        mru: s.workspaceSplitAnchorMru,
        activeAnchorId: anchorId
      })
      set({
        workspaceSplitLayout: removed,
        activeWorkspaceSplitAnchorId: normalized.activeAnchorId,
        workspaceSplitLayoutsByAnchor: normalized.byAnchor,
        workspaceSplitAnchorMru: normalized.mru,
        workspaceSplitMaximizedPaneId: null
      })
    } else {
      // Below 2 leaves the association dissolves — the closed pane's project
      // is simply reachable standalone again, terminals untouched.
      const nextByAnchor = { ...s.workspaceSplitLayoutsByAnchor }
      delete nextByAnchor[anchorId]
      set({
        workspaceSplitLayout: null,
        activeWorkspaceSplitAnchorId: null,
        workspaceSplitLayoutsByAnchor: nextByAnchor,
        workspaceSplitAnchorMru: s.workspaceSplitAnchorMru.filter((id) => id !== anchorId),
        workspaceSplitMaximizedPaneId: null
      })
    }
    // Why: closing the focused pane must land focus on what remains visible,
    // not leave the removed project rendered full-width.
    if (s.activeWorktreeId === worktreeId && survivorIds[0]) {
      get().setActiveWorktree(survivorIds[0])
    }
  },

  setWorkspaceSplitRatio: (splitPath, ratio) => {
    const s = get()
    const layout = s.workspaceSplitLayout
    const anchorId = s.activeWorkspaceSplitAnchorId
    if (!layout || !anchorId) {
      return
    }
    const next = updateWorkspaceSplitRatioAtPath(layout, splitPath, clampWorkspaceSplitRatio(ratio))
    if (next !== layout) {
      set({
        workspaceSplitLayout: next,
        workspaceSplitLayoutsByAnchor: { ...s.workspaceSplitLayoutsByAnchor, [anchorId]: next }
      })
    }
  },

  removeWorktreesFromSplitView: (worktreeIds) => {
    const s = get()
    const next = pruneWorkspaceSplitState(s, new Set(worktreeIds))
    if (
      next.workspaceSplitLayout !== s.workspaceSplitLayout ||
      next.workspaceSplitLayoutsByAnchor !== s.workspaceSplitLayoutsByAnchor ||
      next.activeWorkspaceSplitAnchorId !== s.activeWorkspaceSplitAnchorId ||
      next.workspaceSplitAnchorMru !== s.workspaceSplitAnchorMru ||
      next.workspaceSplitMaximizedPaneId !== s.workspaceSplitMaximizedPaneId
    ) {
      set(next)
    }
  }
})
