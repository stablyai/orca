import { useEffect, useState } from 'react'

export function useQwenWorkAvailable(enabled = true): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void window.api.shell?.isQwenWorkAvailable?.().then(
      (installed) => {
        if (!cancelled) {
          setAvailable(installed)
        }
      },
      () => {
        if (!cancelled) {
          setAvailable(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [enabled])
  return enabled && available
}
