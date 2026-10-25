import { useEffect, useMemo } from 'react'
import { createUnreadBadgeCountSelector } from '@/lib/unread-badge-count-selector'
import { useAppStore } from '@/store'
import { selectFloatingWorkspaceHasUnread } from '@/store/selectors'

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

export function useUnreadDockBadge(
  floatingTerminalOpen: boolean
): typeof clearUnreadDockBadgeCount {
  // Select the badge integer so title frames neither rescan nor rerender the App root.
  const selectUnreadBadgeCount = useMemo(() => createUnreadBadgeCountSelector(), [])
  const unreadWorkspaceCount = useAppStore(selectUnreadBadgeCount)
  // Why: the floating terminal has no workspace flag, so it counts exactly while its launcher shows the dot.
  const floatingTerminalHasUnread = useAppStore(
    (s) => s.settings?.floatingTerminalEnabled === true && selectFloatingWorkspaceHasUnread(s)
  )
  const unreadCount =
    unreadWorkspaceCount + (floatingTerminalHasUnread && !floatingTerminalOpen ? 1 : 0)

  useEffect(() => {
    setUnreadDockBadgeCountBestEffort(unreadCount)
  }, [unreadCount])

  return clearUnreadDockBadgeCount
}
