import { useCallback, useSyncExternalStore } from 'react'

const MAX_TIMEOUT_MS = 2_147_483_647

/** Whether Continue applies yet. One wake at `at`; focus and visibility recheck a changed clock. */
// The subscription only invalidates the view; fresh wall time decides on every read.
export function useUsageLimitContinueClock(at: number | undefined): boolean {
  const subscribe = useCallback(
    (invalidate: () => void) => {
      if (at === undefined) {
        return () => {}
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = (): void => {
        clearTimeout(timer)
        const delay = at - Date.now()
        timer = delay > 0 ? setTimeout(refresh, Math.min(delay, MAX_TIMEOUT_MS)) : undefined
        invalidate()
      }
      refresh()
      window.addEventListener('focus', refresh)
      document.addEventListener('visibilitychange', refresh)
      return () => {
        clearTimeout(timer)
        window.removeEventListener('focus', refresh)
        document.removeEventListener('visibilitychange', refresh)
      }
    },
    [at]
  )
  return useSyncExternalStore(subscribe, () => at !== undefined && Date.now() >= at)
}
