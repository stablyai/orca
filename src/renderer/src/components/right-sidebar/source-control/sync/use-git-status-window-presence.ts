import { useEffect } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import type { GitStatusRefreshScheduler } from './git-status-refresh-scheduler'

/** Pause the status scheduler while hidden and catch up on reveal. */
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
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [schedulerRef, canFetch, pollScope])
}
