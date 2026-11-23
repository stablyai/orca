// A paired computer announces no change to this window, so while the bot has workspaces handed to it
// there, Activity re-reads on a backing-off timer, only while the window is visible. It follows the
// registrations, not the rows shown: an offline or empty answer must not end it.
import { useEffect } from 'react'

export const PAIRED_AGENTS_FIRST_REFRESH_MS = 15_000
export const PAIRED_AGENTS_MAX_REFRESH_MS = 120_000

export function usePairedActivityRefresh(active: boolean, refresh: () => void): void {
  useEffect(() => {
    if (!active) {
      return
    }
    let delay = PAIRED_AGENTS_FIRST_REFRESH_MS
    let timer = 0
    const next = (): void => {
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') {
          refresh()
        }
        delay = Math.min(delay * 2, PAIRED_AGENTS_MAX_REFRESH_MS)
        next()
      }, delay)
    }
    next()
    return () => window.clearTimeout(timer)
  }, [active, refresh])
}
