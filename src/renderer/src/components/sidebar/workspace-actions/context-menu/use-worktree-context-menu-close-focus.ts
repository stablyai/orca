import { useCallback, useRef } from 'react'
import { overlayFocusContains } from '@/lib/overlay-interaction/overlay-focus-ownership'

export function useWorktreeContextMenuCloseFocus(scopeRef: React.RefObject<HTMLDivElement | null>) {
  const menuOpenRef = useRef(false)
  const dismissedOutsideRef = useRef(false)

  const syncMenuOpen = useCallback((open: boolean) => {
    menuOpenRef.current = open
    if (open) {
      dismissedOutsideRef.current = false
    }
  }, [])

  const handleInteractOutside = useCallback((event: Event) => {
    if (!event.defaultPrevented) {
      dismissedOutsideRef.current = true
    }
  }, [])

  const restoreSidebarFocusOnClose = useCallback(
    (closingMenu: EventTarget | null) => {
      const dismissedOutside = dismissedOutsideRef.current
      dismissedOutsideRef.current = false
      if (menuOpenRef.current || dismissedOutside) {
        return
      }
      const activeElement = document.activeElement
      if (
        activeElement instanceof HTMLElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement &&
        !(closingMenu instanceof HTMLElement && overlayFocusContains(closingMenu, activeElement))
      ) {
        return
      }
      const sidebar = scopeRef.current?.closest('[data-worktree-sidebar]')
      if (sidebar instanceof HTMLElement) {
        sidebar.focus({ preventScroll: true })
      }
    },
    [scopeRef]
  )

  const consumeDismissedOutside = useCallback(() => {
    dismissedOutsideRef.current = false
  }, [])

  return {
    consumeDismissedOutside,
    handleInteractOutside,
    restoreSidebarFocusOnClose,
    syncMenuOpen
  }
}
