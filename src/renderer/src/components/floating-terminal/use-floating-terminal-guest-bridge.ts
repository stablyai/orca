import { useEffect } from 'react'
import {
  FLOATING_WORKSPACE_GUEST_CLOSE_EVENT,
  FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT,
  type FloatingWorkspaceGuestCloseDetail,
  type FloatingWorkspaceGuestSelectIndexDetail
} from '@/lib/floating-workspace-guest-bridge'
import type { FloatingTerminalPanelShortcuts } from './use-floating-terminal-panel-shortcuts'

type FloatingTerminalGuestBridgeInput = Pick<
  FloatingTerminalPanelShortcuts,
  'floatingShortcutListenersRef'
> & { open: boolean }

export function useFloatingTerminalGuestBridge({
  floatingShortcutListenersRef,
  open
}: FloatingTerminalGuestBridgeInput): void {
  useEffect(() => {
    if (!open || typeof window === 'undefined') {
      return
    }
    const handleGuestClose = (event: Event): void => {
      const detail = (event as CustomEvent<FloatingWorkspaceGuestCloseDetail>).detail
      if (detail) {
        floatingShortcutListenersRef.current.closeFloatingItemConfirmed(detail.sourceId, {
          guestOwned: true
        })
      }
    }
    const handleGuestSelectIndex = (event: Event): void => {
      const detail = (event as CustomEvent<FloatingWorkspaceGuestSelectIndexDetail>).detail
      const listeners = floatingShortcutListenersRef.current
      const visibleId = detail ? listeners.visibleFloatingTabOrder[detail.index] : undefined
      if (visibleId) {
        listeners.activateFloatingItem(visibleId)
      }
    }
    window.addEventListener(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT, handleGuestClose)
    window.addEventListener(FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT, handleGuestSelectIndex)
    return () => {
      window.removeEventListener(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT, handleGuestClose)
      window.removeEventListener(
        FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT,
        handleGuestSelectIndex
      )
    }
  }, [floatingShortcutListenersRef, open])
}
