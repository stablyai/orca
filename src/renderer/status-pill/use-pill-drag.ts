import { useRef, useState } from 'react'

// Why: a pointer interaction on the pill body can be either a click (focus the
// main window) or a drag (reposition the pill). This hook owns the drag state
// machine — mousedown starts tracking, a move past a 4px threshold becomes a
// drag that repositions the window via IPC, and a click that follows a drag is
// suppressed. Keeping it in a hook lets the renderer (main.tsx) stay under the
// per-file line budget.

const DRAG_THRESHOLD_PX = 4

type DragState = {
  startScreenX: number
  startScreenY: number
  startWinX: number
  startWinY: number
  ready: boolean
  moved: boolean
}

export type UsePillDrag = {
  /** Attach to the pill body's onMouseDown. Left button starts a potential drag. */
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void
  /** True while a drag is in progress (drives the grabbing cursor + no-lift class). */
  dragging: boolean
  /** Call from the click handler; returns true when the click is the tail of a
   *  drag and should be ignored (and resets the flag). */
  consumeClick: () => boolean
}

export function usePillDrag(): UsePillDrag {
  const dragState = useRef<DragState | null>(null)
  // Why: persists across the mouseup→click sequence so the click handler can
  // tell a real click apart from the tail of a drag.
  const didDragRef = useRef(false)
  const [dragging, setDragging] = useState(false)

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    // Why: only the primary button starts a drag; the secondary button is the
    // context menu and should not begin repositioning.
    if (event.button !== 0) {
      return
    }
    const api = window.api
    if (!api) {
      return
    }
    const state: DragState = {
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWinX: 0,
      startWinY: 0,
      ready: false,
      moved: false
    }
    dragState.current = state
    // Why: lock the overlay into capturing mode for the whole press so the
    // click-through poll can't sever a drag when the cursor briefly leaves the
    // content rect (window-lag during fast moves).
    api.setCapturing(true)
    void api.getWindowPosition().then((pos) => {
      // Why: only adopt the start origin if this pointer is still the active
      // one — a later pointer down must not be overwritten by a stale resolve.
      if (dragState.current === state) {
        state.startWinX = pos.x
        state.startWinY = pos.y
        state.ready = true
      }
    })
    const onMove = (ev: MouseEvent): void => {
      const s = dragState.current
      if (!s || !s.ready) {
        return
      }
      const dx = ev.screenX - s.startScreenX
      const dy = ev.screenY - s.startScreenY
      // Why: ignore sub-pixel jitter so a static click never becomes a drag.
      if (!s.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
          return
        }
        s.moved = true
        didDragRef.current = true
        setDragging(true)
      }
      window.api?.setWindowPosition({ x: s.startWinX + dx, y: s.startWinY + dy })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragState.current = null
      setDragging(false)
      window.api?.setCapturing(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const consumeClick = (): boolean => {
    if (didDragRef.current) {
      didDragRef.current = false
      return true
    }
    return false
  }

  return { onMouseDown, dragging, consumeClick }
}
