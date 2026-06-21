import type { DropZone, ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import type { PaneStyleOptions } from './pane-manager-types'
import { detachPaneFromTree, insertPaneNextTo } from './pane-tree-ops'

// ---------------------------------------------------------------------------
// Drag-to-reorder panes
// ---------------------------------------------------------------------------

export type DragReorderState = {
  dragSourcePaneId: number | null
  dropOverlay: HTMLElement | null
  currentDropTarget: { paneId: number; zone: DropZone } | null
  cleanupActiveDrag: ((commitDrop: boolean) => void) | null
}

export type DragReorderCallbacks = {
  getPanes: () => Map<number, ManagedPaneInternal>
  getRoot: () => HTMLElement
  getStyleOptions: () => PaneStyleOptions
  isDestroyed: () => boolean
  safeFit: (pane: ManagedPane) => void
  applyPaneOpacity: () => void
  applyDividerStyles: () => void
  refitPanesUnder: (el: HTMLElement) => void
  requestPaneReparentFrame?: (callback: FrameRequestCallback) => void
  onLayoutChanged?: () => void
  onDragActiveChange?: (active: boolean) => void
}

export function createDragReorderState(): DragReorderState {
  return {
    dragSourcePaneId: null,
    dropOverlay: null,
    currentDropTarget: null,
    cleanupActiveDrag: null
  }
}

export function cancelActivePaneDrag(state: DragReorderState): void {
  if (state.cleanupActiveDrag) {
    state.cleanupActiveDrag(false)
    return
  }
  hideDropOverlay(state)
  state.dragSourcePaneId = null
  state.currentDropTarget = null
}

/** Move a pane from its current position to a new position relative to a target pane. */
export function handlePaneDrop(
  sourcePaneId: number,
  targetPaneId: number,
  zone: DropZone,
  _state: DragReorderState,
  callbacks: DragReorderCallbacks
): void {
  if (sourcePaneId === targetPaneId) {
    return
  }
  const panes = callbacks.getPanes()
  const source = panes.get(sourcePaneId)
  const target = panes.get(targetPaneId)
  if (!source || !target) {
    return
  }

  // 1. Detach source pane from the tree (without disposing its terminal)
  detachPaneFromTree(source, callbacks)

  // 2. Insert source next to target in the requested zone
  insertPaneNextTo(source, target, zone, callbacks)

  // 3. Refit all panes and persist
  for (const p of panes.values()) {
    callbacks.safeFit(p)
  }
  callbacks.applyPaneOpacity()
  callbacks.applyDividerStyles()
  updateMultiPaneState(callbacks)
  callbacks.onLayoutChanged?.()
}

export function showDropOverlay(state: DragReorderState): void {
  if (!state.dropOverlay) {
    const overlay = document.createElement('div')
    overlay.className = 'pane-drop-overlay'
    document.body.appendChild(overlay)
    state.dropOverlay = overlay
  }
  state.dropOverlay.style.display = 'none'
}

export function hideDropOverlay(state: DragReorderState): void {
  if (state.dropOverlay) {
    state.dropOverlay.remove()
    state.dropOverlay = null
  }
}

/** Add/remove .has-multiple-panes on root to control drag handle visibility. */
export function updateMultiPaneState(callbacks: DragReorderCallbacks): void {
  if (callbacks.getPanes().size >= 2) {
    callbacks.getRoot().classList.add('has-multiple-panes')
  } else {
    callbacks.getRoot().classList.remove('has-multiple-panes')
  }
}
