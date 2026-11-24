import { useEffect } from 'react'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import type { GitStatusRefreshScheduler } from './git-status-refresh-scheduler'

/** Pause the status scheduler while hidden, catch up on reveal, and re-time it on window focus. */
export function useGitStatusWindowPresence(
  schedulerRef: { readonly current: GitStatusRefreshScheduler | null },
  canFetch: boolean,
  pollScope: string | null
): void {
  useEffect(() => {
    const reconcile = (catchUp: boolean): void => {
      const scheduler = schedulerRef.current
      if (!scheduler) {
        return
      }
      if (!canFetch || !isWindowVisible()) {
        scheduler.pause()
        return
      }
      if (pollScope) {
        scheduler.resumeSafety()
        return
      }
      scheduler.suspendSafety()
      if (catchUp) {
        scheduler.refreshNow()
      }
    }
    reconcile(false)
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return
    }
    const handleVisibilityChange = (): void => reconcile(isWindowVisible())
    // Unfocused cadence is slower; refocus pulls deferred/overdue refreshes back to the focused cadence.
    const handleWindowFocus = (): void => {
      if (canFetch && isWindowVisible()) {
        schedulerRef.current?.retime()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)
    const stopResume = window.api?.ui?.onSystemResumed?.(() => {
      if (canFetch && isWindowVisible()) {
        schedulerRef.current?.refreshNow()
      }
    })
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
      stopResume?.()
    }
  }, [schedulerRef, canFetch, pollScope])
}
