import type { WorkbenchView } from '../../../shared/types'
import {
  collectLeafWorktreeIds,
  flipAllSplitDirections,
  hasLeaf,
  leafCount,
  makeWorktreeLeaf,
  removeLeaf,
  replaceLeaf,
  setRatioAtPath,
  splitLeafByWorktreeId,
  toggleParentSplitDirection,
  type WorktreeLayoutPath,
  type WorktreeSplitPlacement
} from './worktree-layout-tree'
import type { WorktreeSplitDirection } from '../../../shared/types'

// Pure, immutable model for the collection of workbench views (the super-tabs).
// Per-view layout edits delegate to worktree-layout-tree; this module owns the
// list, the active view, the focused-pane invariant, and the strip-visibility
// rule. Kept side-effect-free so the workbench-views slice is thin glue and the
// logic is unit-testable. New view/worktree ids are supplied by callers (the
// slice) because id generation is not pure.

export type WorkbenchViewState = {
  workbenchViews: WorkbenchView[]
  activeWorkbenchViewId: string | null
}

export const EMPTY_WORKBENCH_VIEW_STATE: WorkbenchViewState = {
  workbenchViews: [],
  activeWorkbenchViewId: null
}

/** A fresh state holding one single-leaf view — the N=1 case used for legacy
 *  session hydration (synthesized from the persisted activeWorktreeId). */
export function singleLeafViewState(viewId: string, worktreeId: string): WorkbenchViewState {
  return {
    workbenchViews: [
      { id: viewId, layout: makeWorktreeLeaf(worktreeId), focusedWorktreeId: worktreeId }
    ],
    activeWorkbenchViewId: viewId
  }
}

// ─── Selectors ──────────────────────────────────────────────────────

export function getActiveWorkbenchView(state: WorkbenchViewState): WorkbenchView | null {
  if (!state.activeWorkbenchViewId) {
    return null
  }
  return state.workbenchViews.find((v) => v.id === state.activeWorkbenchViewId) ?? null
}

/** Worktrees rendered by the active view — the render gate (surfaces whose id is
 *  in this set are visible; all others stay mounted-hidden). */
export function getVisibleWorktreeIds(state: WorkbenchViewState): string[] {
  const view = getActiveWorkbenchView(state)
  return view ? collectLeafWorktreeIds(view.layout) : []
}

/** The view (parallel set) that contains `worktreeId`, or null. Lets the
 *  workbench render and act on "the set the active worktree belongs to"
 *  regardless of which view is flagged active — so clicking any member switches
 *  to that set. */
export function findViewContaining(
  state: WorkbenchViewState,
  worktreeId: string
): WorkbenchView | null {
  return (
    state.workbenchViews.find((v) => collectLeafWorktreeIds(v.layout).includes(worktreeId)) ?? null
  )
}

/** Progressive disclosure: no always-on second tab layer. The strip appears only
 *  when parallel is actually in use — more than one view, or a multi-pane active
 *  view — unless the user pinned it on. A lone single-leaf view shows zero extra
 *  chrome (identical to the pre-feature workbench). */
export function shouldShowProjectTabStrip(
  state: WorkbenchViewState,
  options?: { pinned?: boolean }
): boolean {
  if (options?.pinned) {
    return true
  }
  if (state.workbenchViews.length > 1) {
    return true
  }
  const view = getActiveWorkbenchView(state)
  return view ? leafCount(view.layout) > 1 : false
}

// ─── View-list operations ───────────────────────────────────────────

/** Append a new single-leaf view. Activates it unless `activate: false`. */
export function createSingleLeafView(
  state: WorkbenchViewState,
  viewId: string,
  worktreeId: string,
  options?: { activate?: boolean }
): WorkbenchViewState {
  const view: WorkbenchView = {
    id: viewId,
    layout: makeWorktreeLeaf(worktreeId),
    focusedWorktreeId: worktreeId
  }
  return {
    workbenchViews: [...state.workbenchViews, view],
    activeWorkbenchViewId: options?.activate === false ? state.activeWorkbenchViewId : viewId
  }
}

export function activateWorkbenchView(
  state: WorkbenchViewState,
  viewId: string
): WorkbenchViewState {
  if (
    viewId === state.activeWorkbenchViewId ||
    !state.workbenchViews.some((v) => v.id === viewId)
  ) {
    return state
  }
  return { ...state, activeWorkbenchViewId: viewId }
}

/** Remove a view; if it was active, activate its right neighbor (else left). */
export function closeWorkbenchView(state: WorkbenchViewState, viewId: string): WorkbenchViewState {
  const index = state.workbenchViews.findIndex((v) => v.id === viewId)
  if (index === -1) {
    return state
  }
  const workbenchViews = state.workbenchViews.filter((v) => v.id !== viewId)
  let activeWorkbenchViewId = state.activeWorkbenchViewId
  if (activeWorkbenchViewId === viewId) {
    activeWorkbenchViewId = (workbenchViews[index] ?? workbenchViews[index - 1] ?? null)?.id ?? null
  }
  return { workbenchViews, activeWorkbenchViewId }
}

export function renameWorkbenchView(
  state: WorkbenchViewState,
  viewId: string,
  title: string
): WorkbenchViewState {
  const trimmed = title.trim()
  return {
    ...state,
    workbenchViews: state.workbenchViews.map((v) =>
      v.id === viewId ? { ...v, title: trimmed.length > 0 ? trimmed : undefined } : v
    )
  }
}

/** Move `viewId` to `toIndex` (clamped), preserving strip order. */
export function moveWorkbenchView(
  state: WorkbenchViewState,
  viewId: string,
  toIndex: number
): WorkbenchViewState {
  const from = state.workbenchViews.findIndex((v) => v.id === viewId)
  if (from === -1) {
    return state
  }
  const clamped = Math.min(Math.max(toIndex, 0), state.workbenchViews.length - 1)
  if (clamped === from) {
    return state
  }
  const workbenchViews = [...state.workbenchViews]
  const [moved] = workbenchViews.splice(from, 1)
  workbenchViews.splice(clamped, 0, moved)
  return { ...state, workbenchViews }
}

// ─── Active-view (pane) operations ──────────────────────────────────

/** Apply `fn` to the active view. A `null` return closes the view (its layout
 *  emptied); an unchanged return is a no-op. */
function mapActiveView(
  state: WorkbenchViewState,
  fn: (view: WorkbenchView) => WorkbenchView | null
): WorkbenchViewState {
  const active = getActiveWorkbenchView(state)
  if (!active) {
    return state
  }
  const next = fn(active)
  if (next === active) {
    return state
  }
  if (next === null) {
    return closeWorkbenchView(state, active.id)
  }
  return {
    ...state,
    workbenchViews: state.workbenchViews.map((v) => (v.id === active.id ? next : v))
  }
}

/** Split the pane showing `targetWorktreeId` in the active view, adding
 *  `newWorktreeId` beside it and focusing it. No-op if `newWorktreeId` is
 *  already visible (a worktree surface is a DOM singleton). */
export function splitActivePane(
  state: WorkbenchViewState,
  targetWorktreeId: string,
  direction: WorktreeSplitDirection,
  newWorktreeId: string,
  placement: WorktreeSplitPlacement = 'after'
): WorkbenchViewState {
  return mapActiveView(state, (view) => {
    const layout = splitLeafByWorktreeId(
      view.layout,
      targetWorktreeId,
      direction,
      newWorktreeId,
      placement
    )
    if (layout === view.layout) {
      return view
    }
    return { ...view, layout, focusedWorktreeId: newWorktreeId }
  })
}

/** Remove a pane from the active view, collapsing the split. If the view empties
 *  it is closed. Focus moves to a surviving leaf when the focused pane went away. */
export function closeActivePane(state: WorkbenchViewState, worktreeId: string): WorkbenchViewState {
  return mapActiveView(state, (view) => {
    const layout = removeLeaf(view.layout, worktreeId)
    if (layout === view.layout) {
      return view
    }
    if (layout === null) {
      return null
    }
    const focusedWorktreeId = hasLeaf(layout, view.focusedWorktreeId)
      ? view.focusedWorktreeId
      : collectLeafWorktreeIds(layout)[0]
    return { ...view, layout, focusedWorktreeId }
  })
}

/** Retarget the focused pane of the active view to `newWorktreeId`. If that
 *  worktree is already visible, just focus it (FR-11: sidebar click in a
 *  multi-pane view retargets the focused pane, or focuses if already shown). */
export function retargetFocusedPane(
  state: WorkbenchViewState,
  newWorktreeId: string
): WorkbenchViewState {
  return mapActiveView(state, (view) => {
    if (view.focusedWorktreeId === newWorktreeId) {
      return view
    }
    if (hasLeaf(view.layout, newWorktreeId)) {
      return { ...view, focusedWorktreeId: newWorktreeId }
    }
    const layout = replaceLeaf(view.layout, view.focusedWorktreeId, newWorktreeId)
    if (layout === view.layout) {
      return view
    }
    return { ...view, layout, focusedWorktreeId: newWorktreeId }
  })
}

export function setActivePaneRatio(
  state: WorkbenchViewState,
  path: WorktreeLayoutPath,
  ratio: number
): WorkbenchViewState {
  return mapActiveView(state, (view) => {
    const layout = setRatioAtPath(view.layout, path, ratio)
    return layout === view.layout ? view : { ...view, layout }
  })
}

/** Focus a pane already visible in the active view. No-op otherwise. */
export function focusActivePane(state: WorkbenchViewState, worktreeId: string): WorkbenchViewState {
  return mapActiveView(state, (view) => {
    if (view.focusedWorktreeId === worktreeId || !hasLeaf(view.layout, worktreeId)) {
      return view
    }
    return { ...view, focusedWorktreeId: worktreeId }
  })
}

/** Flip the active view's split orientation (side-by-side <-> stacked). */
export function flipActiveViewOrientation(state: WorkbenchViewState): WorkbenchViewState {
  return mapActiveView(state, (view) =>
    view.layout.type === 'split' ? { ...view, layout: flipAllSplitDirections(view.layout) } : view
  )
}

/** Flip the orientation of just the split containing `worktreeId`'s pane. */
export function togglePaneSplitDirection(
  state: WorkbenchViewState,
  worktreeId: string
): WorkbenchViewState {
  return mapActiveView(state, (view) => {
    const layout = toggleParentSplitDirection(view.layout, worktreeId)
    return layout === view.layout ? view : { ...view, layout }
  })
}
