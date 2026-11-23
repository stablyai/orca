import { useEffect, useRef } from 'react'

/** Calls `recheck` once per wait, `delayMs` after `waiting` turns true, however often the caller
 *  re-renders meanwhile. `recheck` returns false when it couldn't run yet; it is then tried again a
 *  second later. Leaving the waiting state cancels a pending call and arms the next wait. */
export function useRecheckOnce(waiting: boolean, delayMs: number, recheck: () => boolean): void {
  const latest = useRef(recheck)
  useEffect(() => {
    latest.current = recheck
  })
  const done = useRef(false)
  useEffect(() => {
    if (!waiting) {
      done.current = false
      return
    }
    if (done.current) {
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const attempt = () => {
      if (latest.current()) {
        done.current = true
      } else {
        timer = setTimeout(attempt, 1_000)
      }
    }
    timer = setTimeout(attempt, delayMs)
    return () => clearTimeout(timer)
  }, [waiting, delayMs])
}
