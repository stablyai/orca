import { useEffect, useMemo } from 'react'
import { createUnreadBadgeCountSelector } from '@/lib/unread-badge-count-selector'
import { useAppStore } from '@/store'
import { selectFloatingWorkspaceHasUnread } from '@/store/selectors'
import type { AppState } from '@/store/types'

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

/** Keeps the OS Dock badge in sync with the unread-workspace count; returns the badge clearer. */
export function useUnreadDockBadge(): typeof clearUnreadDockBadgeCount {
  // Why a selector and not the raw maps: this hook is mounted on the App root, so subscribing to
  // workspace or tab maps would re-render the entire shell on every title frame. The selector
  // recounts only when a workspace flag or the floating unread boolean moves, and the subscription
  // stays quiet unless the badge integer itself changes.
  const selectUnreadBadgeCount = useMemo(
    () => createUnreadBadgeCountSelector<AppState>(selectFloatingWorkspaceHasUnread),
    []
  )
  const unreadCount = useAppStore(selectUnreadBadgeCount)

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: this syncs an external OS dock badge, not React render state.
  useEffect(() => {
    setUnreadDockBadgeCountBestEffort(unreadCount)
  }, [unreadCount])

  return clearUnreadDockBadgeCount
}
