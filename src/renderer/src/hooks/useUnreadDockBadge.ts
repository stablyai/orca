import { useEffect } from 'react'
import { getUnreadBadgeCount } from '@/lib/unread-badge-count'
import { useAppStore } from '@/store'

export function useUnreadDockBadge(): void {
  const unreadCount = useAppStore((state) =>
    getUnreadBadgeCount({
      worktreesByRepo: state.worktreesByRepo,
      tabsByWorktree: state.tabsByWorktree,
      unreadTerminalTabs: state.unreadTerminalTabs
    })
  )

  useEffect(() => {
    void window.api.app.setUnreadDockBadgeCount(unreadCount).catch(() => {
      // Dock sync is best-effort chrome; stale badge state should not affect app use.
    })
  }, [unreadCount])

  useEffect(() => {
    return () => {
      void window.api.app.setUnreadDockBadgeCount(0).catch(() => {})
    }
  }, [])
}
