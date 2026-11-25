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
  // The local day and zone ride along so a wake after a date or time-zone change re-renders the
  // row's formatted times, not only the eligibility flip.
  const snapshot = useSyncExternalStore(subscribe, () => {
    const now = new Date()
    const passed = at !== undefined && now.getTime() >= at
    // The zone's name, not just today's offset: two zones can agree now and differ at the reset.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return `${passed ? 'ready' : 'waiting'}|${now.toDateString()}|${zone}`
  })
  return snapshot.startsWith('ready|')
}
