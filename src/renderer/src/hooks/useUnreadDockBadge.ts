import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getUnreadBadgeCount } from '@/lib/unread-badge-count'
import { useAppStore } from '@/store'

function setUnreadDockBadgeCountBestEffort(count: number): void {
  const setBadge = window.api?.app?.setUnreadDockBadgeCount
  if (!setBadge) {
    return
  }
  void setBadge(count).catch(() => {
    // Dock sync is best-effort chrome; stale badge state should not affect app use.
  })
}

export function clearUnreadDockBadgeCount(): void {
  setUnreadDockBadgeCountBestEffort(0)
}

export function useUnreadDockBadge(): typeof clearUnreadDockBadgeCount {
  const { worktreesByRepo, tabsByWorktree, unreadTerminalTabs } = useAppStore(
    useShallow((state) => ({
      worktreesByRepo: state.worktreesByRepo,
      tabsByWorktree: state.tabsByWorktree,
      unreadTerminalTabs: state.unreadTerminalTabs
    }))
  )
  // Why: this hook is always mounted; unrelated remote writes must not rescan every workspace.
  const unreadCount = useMemo(
    () => getUnreadBadgeCount({ worktreesByRepo, tabsByWorktree, unreadTerminalTabs }),
    [tabsByWorktree, unreadTerminalTabs, worktreesByRepo]
  )

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: this syncs an external OS dock badge, not React render state.
  useEffect(() => {
    setUnreadDockBadgeCountBestEffort(unreadCount)
  }, [unreadCount])

  return clearUnreadDockBadgeCount
}
