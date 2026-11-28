import { useCallback, useEffect, useRef } from 'react'

/** Closes a submenu `delayMs` after the pointer moves elsewhere, unless it comes back first; the first
 *  `schedule` starts the countdown and later ones keep it, so pointer moves don't keep restarting it. */
export function useDelayedSubmenuClose(
  close: () => void,
  delayMs: number
): { schedule: () => void; cancel: () => void } {
  const timer = useRef<number | undefined>(undefined)
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  }, [close])
  const cancel = useCallback((): void => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const schedule = useCallback((): void => {
    if (timer.current !== undefined) {
      return
    }
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      closeRef.current()
    }, delayMs)
  }, [delayMs])
  useEffect(() => cancel, [cancel])
  return { schedule, cancel }
}

function distanceToRect(rect: DOMRect, x: number, y: number): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right)
  const dy = Math.max(rect.top - y, 0, y - rect.bottom)
  return Math.hypot(dx, dy)
}

/** Whether a pointer that moved from `from` to `to` got closer to `rect`: it is heading for that list. */
export function pointerHeadsFor(
  rect: DOMRect,
  from: { x: number; y: number },
  to: { x: number; y: number }
): boolean {
  return distanceToRect(rect, to.x, to.y) < distanceToRect(rect, from.x, from.y)
}
