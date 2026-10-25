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
  // Why a selector and not the raw maps: this hook is mounted on the App root, so subscribing to
  // `tabsByWorktree` re-rendered the entire shell on every title frame. The selector both skips the
  // rescan and keeps the subscription quiet unless the badge integer itself changes.
  const selectUnreadBadgeCount = useMemo(() => createUnreadBadgeCountSelector(), [])
  const unreadWorkspaceCount = useAppStore(selectUnreadBadgeCount)
  // Why: the floating terminal has no workspace flag, so it counts exactly while its launcher shows the dot.
  const floatingTerminalHasUnread = useAppStore(
    (s) => s.settings?.floatingTerminalEnabled === true && selectFloatingWorkspaceHasUnread(s)
  )
  const unreadCount =
    unreadWorkspaceCount + (floatingTerminalHasUnread && !floatingTerminalOpen ? 1 : 0)

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: this syncs an external OS dock badge, not React render state.
  useEffect(() => {
    setUnreadDockBadgeCountBestEffort(unreadCount)
  }, [unreadCount])

  return clearUnreadDockBadgeCount
}
