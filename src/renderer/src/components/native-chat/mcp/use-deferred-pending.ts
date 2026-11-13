import { useEffect, useState } from 'react'

/** Deferred so a fast local round trip never flashes a spinner; the control greys at once. */
export function useDeferredPending(pending: boolean): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!pending) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), 200)
    return () => clearTimeout(timer)
  }, [pending])
  return shown
}
