import { useEffect } from 'react'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'

function setUnreadDockBadgeCountBestEffort(count: number): void {
  void window.api.app.setUnreadDockBadgeCount(count).catch(() => {
    // Dock sync is best-effort chrome; stale badge state should not affect app use.
  })
}

export function clearUnreadDockBadgeCount(): void {
  setUnreadDockBadgeCountBestEffort(0)
}

export function useUnreadDockBadge(): typeof clearUnreadDockBadgeCount {
  const unreadCount = useActivityUnreadCount(true, 'agent-threads')

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: this syncs an external OS dock badge, not React render state.
  useEffect(() => {
    setUnreadDockBadgeCountBestEffort(unreadCount)
  }, [unreadCount])

  return clearUnreadDockBadgeCount
}
