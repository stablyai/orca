/** Grab size every resize divider reaches; the visible line and the divider's layout box never change. */
export const DIVIDER_HIT_PX = 16

/** Extra grab width added on the divider's far side (away from scrollbars) so `extentPx` reaches the shared size. */
export function getDividerFarOverhangPx(extentPx: number): number {
  return Math.max(0, DIVIDER_HIT_PX - extentPx)
}

const NATIVE_DRAG_ATTRIBUTE = 'data-divider-dragging'
let nativeDragGuardInstalled = false

/**
 * Widened grab areas must not swallow HTML drag-and-drop near pane edges, so CSS turns them off while
 * html[data-divider-dragging] is set. Any stale state only removes the widening (today's geometry).
 */
export function installDividerNativeDragGuard(): void {
  if (nativeDragGuardInstalled || typeof window === 'undefined') {
    return
  }
  nativeDragGuardInstalled = true
  const root = document.documentElement
  // Why: dragenter on the new target precedes dragleave on the old one, so 0 means the drag left the window or was cancelled.
  let depth = 0
  const clear = (): void => {
    depth = 0
    root.removeAttribute(NATIVE_DRAG_ATTRIBUTE)
  }
  const clearIfStale = (): void => {
    if (root.hasAttribute(NATIVE_DRAG_ATTRIBUTE)) {
      clear()
    }
  }
  // Why: synthetic events from scripts don't reflect the user's drag session, so they must not set or clear the guard.
  const listen = (type: string, handler: () => void, capture: boolean): void => {
    window.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) {
          handler()
        }
      },
      capture
    )
  }
  listen(
    'dragenter',
    () => {
      depth += 1
      root.setAttribute(NATIVE_DRAG_ATTRIBUTE, '')
    },
    true
  )
  listen(
    'dragleave',
    () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        clear()
      }
    },
    true
  )
  listen('drop', clear, true)
  listen('dragend', clear, true)
  listen('blur', clear, false)
  // Why: Chromium sends no pointer events during a drag session, so the first real one proves it ended.
  listen('pointermove', clearIfStale, true)
  listen('pointerdown', clearIfStale, true)
}
