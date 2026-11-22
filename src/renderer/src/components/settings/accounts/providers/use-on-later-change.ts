import { useEffect, useRef } from 'react'

/** Calls `changed` when `key` moves from one known value to another; the first known value, and
 *  `null` (not known yet), call nothing. */
export function useOnLaterChange(key: string | null, changed: () => void): void {
  const seen = useRef(key)
  const latest = useRef(changed)
  useEffect(() => {
    latest.current = changed
  })
  useEffect(() => {
    if (key === null || seen.current === key) {
      return
    }
    const first = seen.current === null
    seen.current = key
    if (!first) {
      latest.current()
    }
  }, [key])
}
