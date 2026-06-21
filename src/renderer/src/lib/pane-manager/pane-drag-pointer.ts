import type { DropZone, ManagedPaneInternal } from './pane-manager-types'
import type { DragReorderCallbacks, DragReorderState } from './pane-drag-reorder'
import { handlePaneDrop, hideDropOverlay, showDropOverlay } from './pane-drag-reorder'

const DRAG_THRESHOLD = 5

export function beginPaneDragFromPointerDown(
  handle: HTMLElement,
  paneId: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks,
  e: PointerEvent
): (() => void) | null {
  let dragging = false
  let startX = 0
  let startY = 0
  let activePointerId: number | null = null

  if ((e.button ?? 0) !== 0 || e.ctrlKey || callbacks.getPanes().size < 2) {
    return null
  }
  e.preventDefault()
  e.stopPropagation()
  handle.setPointerCapture(e.pointerId)
  activePointerId = e.pointerId
  startX = e.clientX
  startY = e.clientY

  const cleanupDrag = (commitDrop: boolean): void => {
    const pointerId = activePointerId
    handle.removeEventListener('pointermove', onPointerMoveOuter)
    handle.removeEventListener('pointerup', onPointerUpOuter)
    handle.removeEventListener('pointercancel', onPointerCancelOuter)
    handle.removeEventListener('lostpointercapture', onLostPointerCaptureOuter)
    window.removeEventListener('pointermove', onPointerMoveOuter, true)
    window.removeEventListener('pointerup', onPointerUpOuter, true)
    window.removeEventListener('pointercancel', onPointerCancelOuter, true)
    window.removeEventListener('blur', onWindowBlur, true)
    activePointerId = null
    if (state.cleanupActiveDrag === cleanupDrag) {
      state.cleanupActiveDrag = null
    }
    if (pointerId !== null && handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId)
    }
    if (!dragging) {
      return
    }
    dragging = false
    callbacks.getRoot().classList.remove('is-pane-dragging')
    callbacks.getPanes().get(paneId)?.container.classList.remove('is-drag-source')
    try {
      if (commitDrop && state.currentDropTarget && state.dragSourcePaneId !== null) {
        handlePaneDrop(
          state.dragSourcePaneId,
          state.currentDropTarget.paneId,
          state.currentDropTarget.zone,
          state,
          callbacks
        )
      }
    } finally {
      // Why: pointer capture can be lost crossing Electron webviews; always
      // clear the drag overlay/input state so terminals do not stay inert.
      callbacks.onDragActiveChange?.(false)
      hideDropOverlay(state)
      state.dragSourcePaneId = null
      state.currentDropTarget = null
    }
  }

  const onPointerMoveOuter = (ev: PointerEvent): void => {
    if (ev.pointerId !== activePointerId || callbacks.isDestroyed()) {
      if (callbacks.isDestroyed()) {
        cleanupDrag(false)
      }
      return
    }
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      dragging = true
      state.dragSourcePaneId = paneId
      callbacks.getRoot().classList.add('is-pane-dragging')
      callbacks.onDragActiveChange?.(true)
      callbacks.getPanes().get(paneId)?.container.classList.add('is-drag-source')
      showDropOverlay(state)
    }
    if (dragging) {
      updateDropTarget(ev.clientX, ev.clientY, state, callbacks)
    }
  }

  const onPointerUpOuter = (ev: PointerEvent): void => {
    if (ev.pointerId === activePointerId) {
      cleanupDrag(true)
    }
  }
  const onPointerCancelOuter = (ev: PointerEvent): void => {
    if (ev.pointerId === activePointerId) {
      cleanupDrag(false)
    }
  }
  const onLostPointerCaptureOuter = (ev: PointerEvent): void => {
    if (ev.pointerId === activePointerId) {
      cleanupDrag(false)
    }
  }
  const onWindowBlur = (): void => cleanupDrag(false)

  state.cleanupActiveDrag = cleanupDrag
  handle.addEventListener('pointermove', onPointerMoveOuter)
  handle.addEventListener('pointerup', onPointerUpOuter)
  handle.addEventListener('pointercancel', onPointerCancelOuter)
  handle.addEventListener('lostpointercapture', onLostPointerCaptureOuter)
  // Why: title bars live outside the pane subtree; keep tracking if Chromium
  // routes captured pointer moves through the window rather than the handle.
  window.addEventListener('pointermove', onPointerMoveOuter, true)
  window.addEventListener('pointerup', onPointerUpOuter, true)
  window.addEventListener('pointercancel', onPointerCancelOuter, true)
  window.addEventListener('blur', onWindowBlur, true)

  return () => cleanupDrag(false)
}

export function attachPaneDrag(
  handle: HTMLElement,
  paneId: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks
): () => void {
  let cleanupCurrentDrag: (() => void) | null = null
  const onPointerDown = (e: PointerEvent): void => {
    cleanupCurrentDrag = beginPaneDragFromPointerDown(handle, paneId, state, callbacks, e)
  }

  handle.addEventListener('pointerdown', onPointerDown)
  return () => {
    cleanupCurrentDrag?.()
    cleanupCurrentDrag = null
    handle.removeEventListener('pointerdown', onPointerDown)
  }
}

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
  const targetPane = findDropTargetPane(clientX, clientY, state, callbacks)
  if (!targetPane) {
    overlay.style.display = 'none'
    state.currentDropTarget = null
    return
  }

  const rect = targetPane.container.getBoundingClientRect()
  const zone = resolveDropZone(clientX, clientY, rect)
  state.currentDropTarget = { paneId: targetPane.id, zone }
  positionDropOverlay(overlay, rect, zone)
}

function findDropTargetPane(
  clientX: number,
  clientY: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks
): ManagedPaneInternal | null {
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
      return pane
    }
  }
  return null
}

function resolveDropZone(clientX: number, clientY: number, rect: DOMRect): DropZone {
  const relX = (clientX - rect.left) / rect.width
  const relY = (clientY - rect.top) / rect.height
  const distances = {
    top: relY,
    bottom: 1 - relY,
    left: relX,
    right: 1 - relX
  } satisfies Record<DropZone, number>
  return (Object.entries(distances).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'right') as DropZone
}

function positionDropOverlay(overlay: HTMLElement, rect: DOMRect, zone: DropZone): void {
  overlay.style.display = ''
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const halfWidth = rect.width / 2
  const halfHeight = rect.height / 2

  overlay.style.left = `${rect.left + scrollX + (zone === 'right' ? halfWidth : 0)}px`
  overlay.style.top = `${rect.top + scrollY + (zone === 'bottom' ? halfHeight : 0)}px`
  overlay.style.width = `${zone === 'left' || zone === 'right' ? halfWidth : rect.width}px`
  overlay.style.height = `${zone === 'top' || zone === 'bottom' ? halfHeight : rect.height}px`
}
