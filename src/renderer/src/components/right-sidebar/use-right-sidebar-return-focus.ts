import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { hasVisibleOverlay } from '@/lib/visible-overlay'

export function useRightSidebarReturnFocus(
  open: boolean,
  sidebarRef: RefObject<HTMLDivElement | null>
): void {
  const returnTargetRef = useRef<HTMLElement | null>(null)

  const rememberOutsideFocus = useCallback(
    (target: EventTarget | null): void => {
      if (
        target instanceof HTMLElement &&
        target !== document.body &&
        target !== document.documentElement &&
        !sidebarRef.current?.contains(target) &&
        !target.closest('[data-right-sidebar-toggle]')
      ) {
        returnTargetRef.current = target
      }
    },
    [sidebarRef]
  )

  useEffect(() => {
    // Terminals release focus on document pointerdown, before the toggle's handlers run.
    const onFocusIn = (event: FocusEvent): void => rememberOutsideFocus(event.target)
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [rememberOutsideFocus])

  useLayoutEffect(() => {
    rememberOutsideFocus(document.activeElement)
    const target = returnTargetRef.current
    if (
      !target?.isConnected ||
      (document.activeElement !== null && document.activeElement !== document.body) ||
      target.getClientRects().length === 0 ||
      getComputedStyle(target).visibility !== 'visible' ||
      target.closest('[aria-hidden="true"], [inert]') ||
      hasVisibleOverlay({ ignoreContaining: target, ignoreDismissed: true })
    ) {
      return
    }
    target.focus({ preventScroll: true })
  }, [open, rememberOutsideFocus])
}
