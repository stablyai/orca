// Orca Cloud predictive wake from sidebar row intent (hover dwell, release of a press), kept out
// of the upstream hover prewarm. A press that turns into a drag is moving the row, not opening it.
import {
  notePredictiveWakeDragEnd,
  notePredictiveWakeDragStart,
  notePredictiveWakeHoverEnd,
  notePredictiveWakeHoverStart,
  notePredictiveWakeSelect
} from '@/lib/orca-cloud/cloud-predictive-wake'

let windowListenersInstalled = false
// The row a predictive-wake dwell is armed for (outlives the shorter prewarm dwell).
let predictiveHoverId: string | null = null
// The row under a press. Its wake waits for the release: a press held still and then dragged is a
// move, and a debounce alone can't tell the two apart.
let pressedId: string | null = null
let pressX = 0
let pressY = 0
// Set while a row drag is under way, by whichever drag code noticed it first.
let rowDragActive = false
/** Pointer travel with the button held that makes a press a drag (the sidebar's own drags start
 *  within a few pixels; every drag implementation moves at least this far). */
export const ROW_DRAG_SLOP_PX = 4

function installWindowListeners(): void {
  if (windowListenersInstalled || typeof window === 'undefined') {
    return
  }
  windowListenersInstalled = true
  window.addEventListener(
    'wheel',
    () => {
      // Scrolling under a resting pointer is not intent either: restart the wake dwell too.
      if (predictiveHoverId !== null) {
        notePredictiveWakeHoverStart(predictiveHoverId)
      }
    },
    { capture: true, passive: true }
  )
  // A press that turns into a drag is moving the row, not opening it: drop its pending wake.
  window.addEventListener('dragstart', () => noteWorktreeRowDragStart(), { capture: true })
  window.addEventListener('dragend', () => noteWorktreeRowDragEnd(), { capture: true })
  window.addEventListener('drop', () => noteWorktreeRowDragEnd(), { capture: true })
  // Any drag code (native, the sidebar's pointer drag, the board's) moves the pointer with the
  // button held: past the slop, the press is a drag whatever implementation runs it.
  window.addEventListener(
    'pointermove',
    (event) => {
      if (rowDragActive && event.buttons === 0) {
        // A drag whose end never reached the window (its source unmounted mid-drag).
        noteWorktreeRowDragEnd()
        return
      }
      if (
        pressedId !== null &&
        Math.hypot(event.clientX - pressX, event.clientY - pressY) > ROW_DRAG_SLOP_PX
      ) {
        noteWorktreeRowDragStart()
      }
    },
    { capture: true, passive: true }
  )
  window.addEventListener(
    'pointerup',
    () => {
      const released = pressedId
      pressedId = null
      if (rowDragActive) {
        noteWorktreeRowDragEnd()
      } else if (released !== null) {
        notePredictiveWakeSelect(released)
      }
    },
    { capture: true }
  )
  window.addEventListener(
    'pointercancel',
    () => {
      pressedId = null
    },
    { capture: true }
  )
}

/** A row drag began (native or the board's pointer drag): no intent wake fires until it ends. */
export function noteWorktreeRowDragStart(): void {
  predictiveHoverId = null
  pressedId = null
  if (!rowDragActive) {
    rowDragActive = true
    notePredictiveWakeDragStart()
  }
}

export function noteWorktreeRowDragEnd(): void {
  if (rowDragActive) {
    rowDragActive = false
    notePredictiveWakeDragEnd()
  }
}

/** A sleeping cloud workspace starts waking on a longer dwell (no-op for everything else). */
export function notePredictiveRowHoverStart(worktreeId: string): void {
  predictiveHoverId = worktreeId
  notePredictiveWakeHoverStart(worktreeId)
  installWindowListeners()
}

/** The press may become a drag: hold the wake (and stop the hover dwell's) until the release. */
export function notePredictiveRowPress(worktreeId: string, x: number, y: number): void {
  installWindowListeners()
  notePredictiveWakeHoverEnd(worktreeId)
  pressedId = worktreeId
  pressX = x
  pressY = y
}

export function notePredictiveRowHoverEnd(worktreeId: string): void {
  if (predictiveHoverId === worktreeId) {
    predictiveHoverId = null
  }
  notePredictiveWakeHoverEnd(worktreeId)
}
