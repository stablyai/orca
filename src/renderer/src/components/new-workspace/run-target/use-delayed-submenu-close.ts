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
