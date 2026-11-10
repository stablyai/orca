import type {
  DropZone,
  ManagedPane,
  ManagedPaneInternal,
  PaneExternalDropHandler,
  PaneExternalDropResolver,
  PaneDropTaker,
  PaneExternalDropTarget,
  PaneStyleOptions
} from './pane-manager-types'
import { detachPaneFromTree, findPaneChildren, insertPaneNextTo } from './pane-tree-ops'

export type DragReorderState = {
  dragSourcePaneId: number | null
  dropOverlay: HTMLElement | null
  currentDropTarget: { paneId: number; zone: DropZone } | null
  currentExternalDropTarget: PaneExternalDropTarget | null
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
  resolveExternalDropTarget?: PaneExternalDropResolver
  onExternalPaneDrop?: PaneExternalDropHandler
  onDividerRatiosCommitted?: () => void
  takePaneDrop?: PaneDropTaker
}

export function createDragReorderState(): DragReorderState {
  return {
    dragSourcePaneId: null,
    dropOverlay: null,
    currentDropTarget: null,
    currentExternalDropTarget: null,
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
  state.currentExternalDropTarget = null
}

export function isPaneDropNoOp(
  sourcePaneId: number,
  targetPaneId: number,
  zone: DropZone,
  panes: Map<number, ManagedPaneInternal>
): boolean {
  if (sourcePaneId === targetPaneId) {
    return true
  }
  const source = panes.get(sourcePaneId)
  const target = panes.get(targetPaneId)
  if (!source || !target) {
    return true
  }

  const parent = target.container.parentElement
  if (!parent?.classList.contains('pane-split')) {
    return false
  }
  if (source.container.parentElement !== parent) {
    return false
  }

  const children = findPaneChildren(parent)
  const targetIndex = children.indexOf(target.container)
  const sourceIndex = children.indexOf(source.container)
  if (targetIndex === -1 || sourceIndex === -1) {
    return false
  }

  const isVerticalSplit = parent.classList.contains('is-vertical')
  const zoneIsHorizontal = zone === 'top' || zone === 'bottom'
  if (zoneIsHorizontal === isVerticalSplit) {
    return false
  }
  return zone === 'right' || zone === 'bottom'
    ? sourceIndex === targetIndex + 1
    : sourceIndex === targetIndex - 1
}

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
  if (isPaneDropNoOp(sourcePaneId, targetPaneId, zone, panes)) {
    return
  }
  if (!panes.has(sourcePaneId) || !panes.has(targetPaneId)) {
    return
  }
  const move = (): void => movePaneNextTo(sourcePaneId, targetPaneId, zone, callbacks)
  if (!callbacks.takePaneDrop?.({ sourcePaneId, targetPaneId, zone }, move)) {
    move()
  }
}

function movePaneNextTo(
  sourcePaneId: number,
  targetPaneId: number,
  zone: DropZone,
  callbacks: DragReorderCallbacks
): void {
  const panes = callbacks.getPanes()
  const source = panes.get(sourcePaneId)
  const target = panes.get(targetPaneId)
  // Why re-read: a taken drop moves later, when either pane may have closed.
  if (!source || !target || callbacks.isDestroyed()) {
    return
  }

  detachPaneFromTree(source, callbacks)

  insertPaneNextTo(source, target, zone, callbacks)

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

export function updateMultiPaneState(callbacks: DragReorderCallbacks): void {
  if (callbacks.getPanes().size >= 2) {
    callbacks.getRoot().classList.add('has-multiple-panes')
  } else {
    callbacks.getRoot().classList.remove('has-multiple-panes')
  }
}
