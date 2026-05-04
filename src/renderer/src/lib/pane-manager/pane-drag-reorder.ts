import type { DropZone, ManagedPaneInternal } from './pane-manager-types'
import type { PaneStyleOptions } from './pane-manager-types'
import { detachPaneFromTree, insertPaneNextTo } from './pane-tree-ops'

// ---------------------------------------------------------------------------
// Drag-to-reorder panes
// ---------------------------------------------------------------------------

export type DragReorderState = {
  dragSourcePaneId: number | null
  dropOverlay: HTMLElement | null
  currentDropTarget: { paneId: number; zone: DropZone } | null
}

export type DragReorderCallbacks = {
  getPanes: () => Map<number, ManagedPaneInternal>
  getRoot: () => HTMLElement
  getStyleOptions: () => PaneStyleOptions
  isDestroyed: () => boolean
  safeFit: (pane: ManagedPaneInternal) => void
  applyPaneOpacity: () => void
  applyDividerStyles: () => void
  refitPanesUnder: (el: HTMLElement) => void
  onLayoutChanged?: () => void
}

export function createDragReorderState(): DragReorderState {
  return {
    dragSourcePaneId: null,
    dropOverlay: null,
    currentDropTarget: null
  }
}

/** Attach drag-to-reorder handlers to a pane's drag handle. */
export function attachPaneDrag(
  handle: HTMLElement,
  paneId: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks
): void {
  let dragging = false
  let startX = 0
  let startY = 0
  const DRAG_THRESHOLD = 5

  const onPointerDown = (e: PointerEvent): void => {
    // Only start drag if there are 2+ panes
    if (callbacks.getPanes().size < 2) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    handle.setPointerCapture(e.pointerId)
    startX = e.clientX
    startY = e.clientY
    dragging = false

    const onPointerMoveOuter = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
        dragging = true
        state.dragSourcePaneId = paneId
        callbacks.getRoot().classList.add('is-pane-dragging')
        const sourcePane = callbacks.getPanes().get(paneId)
        if (sourcePane) {
          sourcePane.container.classList.add('is-drag-source')
        }
        showDropOverlay(state)
      }
      if (dragging) {
        updateDropTarget(ev.clientX, ev.clientY, state, callbacks)
      }
    }

    const onPointerUpOuter = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId)
      handle.removeEventListener('pointermove', onPointerMoveOuter)
      handle.removeEventListener('pointerup', onPointerUpOuter)

      if (dragging) {
        callbacks.getRoot().classList.remove('is-pane-dragging')
        const sourcePane = callbacks.getPanes().get(paneId)
        if (sourcePane) {
          sourcePane.container.classList.remove('is-drag-source')
        }

        // Execute the drop
        if (state.currentDropTarget && state.dragSourcePaneId !== null) {
          handlePaneDrop(
            state.dragSourcePaneId,
            state.currentDropTarget.paneId,
            state.currentDropTarget.zone,
            state,
            callbacks
          )
        }

        hideDropOverlay(state)
        state.dragSourcePaneId = null
        state.currentDropTarget = null
      }
    }

    handle.addEventListener('pointermove', onPointerMoveOuter)
    handle.addEventListener('pointerup', onPointerUpOuter)
  }

  handle.addEventListener('pointerdown', onPointerDown)
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

/** Determine which pane and zone the cursor is over, and position the overlay. */
function updateDropTarget(
  clientX: number,
  clientY: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks
): void {
  const overlay = state.dropOverlay
  if (!overlay) {
    return
  }

  // Find which pane the cursor is over (excluding the source)
  let targetPane: ManagedPaneInternal | null = null
  for (const pane of callbacks.getPanes().values()) {
    if (pane.id === state.dragSourcePaneId) {
      continue
    }
    const rect = pane.container.getBoundingClientRect()
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      targetPane = pane
      break
    }
  }

  if (!targetPane) {
    overlay.style.display = 'none'
    state.currentDropTarget = null
    return
  }

  const rect = targetPane.container.getBoundingClientRect()
  const relX = (clientX - rect.left) / rect.width
  const relY = (clientY - rect.top) / rect.height

  // Determine zone: which edge is the cursor closest to?
  const distTop = relY
  const distBottom = 1 - relY
  const distLeft = relX
  const distRight = 1 - relX
  const minDist = Math.min(distTop, distBottom, distLeft, distRight)

  let zone: DropZone
  if (minDist === distTop) {
    zone = 'top'
  } else if (minDist === distBottom) {
    zone = 'bottom'
  } else if (minDist === distLeft) {
    zone = 'left'
  } else {
    zone = 'right'
  }

  state.currentDropTarget = { paneId: targetPane.id, zone }

  // Position overlay to cover the target half
  overlay.style.display = ''
  const scrollX = window.scrollX
  const scrollY = window.scrollY

  switch (zone) {
    case 'top':
      overlay.style.left = `${rect.left + scrollX}px`
      overlay.style.top = `${rect.top + scrollY}px`
      overlay.style.width = `${rect.width}px`
      overlay.style.height = `${rect.height / 2}px`
      break
    case 'bottom':
      overlay.style.left = `${rect.left + scrollX}px`
      overlay.style.top = `${rect.top + scrollY + rect.height / 2}px`
      overlay.style.width = `${rect.width}px`
      overlay.style.height = `${rect.height / 2}px`
      break
    case 'left':
      overlay.style.left = `${rect.left + scrollX}px`
      overlay.style.top = `${rect.top + scrollY}px`
      overlay.style.width = `${rect.width / 2}px`
      overlay.style.height = `${rect.height}px`
      break
    case 'right':
      overlay.style.left = `${rect.left + scrollX + rect.width / 2}px`
      overlay.style.top = `${rect.top + scrollY}px`
      overlay.style.width = `${rect.width / 2}px`
      overlay.style.height = `${rect.height}px`
      break
  }
}
