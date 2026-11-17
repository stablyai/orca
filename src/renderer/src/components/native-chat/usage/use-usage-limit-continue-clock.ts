import { useCallback, useSyncExternalStore } from 'react'
import { getIntlLocale } from '@/i18n/i18n'
import { formatLocalizedResetDuration } from '@/components/status-bar/usage/usage-reset-caption'
import { getResetCountdownNextTickDelay } from '../../../../../shared/agent-usage/rate-limits/rate-limit-reset-format'

const MAX_TIMEOUT_MS = 2_147_483_647

/** `passed` once Continue applies; else the time left in the UI language, or null when unknown. */
export type UsageLimitContinueClock = { passed: true } | { passed: false; left: string | null }

// The subscription only invalidates the view; fresh wall time decides on every read.
export function useUsageLimitContinueClock(at: number | undefined): UsageLimitContinueClock {
  const subscribe = useCallback(
    (invalidate: () => void) => {
      if (at === undefined) {
        return () => {}
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = (): void => {
        clearTimeout(timer)
        const now = Date.now()
        const labelDelay = getResetCountdownNextTickDelay(now, [at])
        timer =
          labelDelay === null
            ? undefined
            : setTimeout(refresh, Math.min(labelDelay, at - now, MAX_TIMEOUT_MS))
        invalidate()
      }
      refresh()
      // A wall clock changed by sleep or by hand is caught on the next focus or visibility change.
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
  // A primitive snapshot: true once passed, else the label, so equal labels never re-render.
  const snapshot = useSyncExternalStore(subscribe, () => {
    if (at === undefined) {
      return null
    }
    const now = Date.now()
    return now >= at ? true : (formatLocalizedResetDuration(at, now, getIntlLocale()) ?? true)
  })
  return snapshot === true ? { passed: true } : { passed: false, left: snapshot }
}
