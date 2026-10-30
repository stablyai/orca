import { useEffect, useState } from 'react'

const DRAWER_CLOSE_LINGER_MS = 300

/** Keep a drawer mounted through its close transition after the store flag drops. */
export function useDrawerCloseLingering(open: boolean): boolean {
  const [lingering, setLingering] = useState(open)
  useEffect(() => {
    if (open) {
      setLingering(true)
      return
    }
    const timer = window.setTimeout(() => setLingering(false), DRAWER_CLOSE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [open])
  return lingering
}
