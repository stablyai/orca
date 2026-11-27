import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** A footer action (Stop all, Clear failed) that leaves while it holds focus hands focus to the
 *  pill, never the page. Focus the user has already moved elsewhere is left where it is. `actions`
 *  names the footer's current actions; any change may remove the focused one. */
export function useWorkerDockFooterFocus(
  root: RefObject<HTMLElement | null>,
  pill: RefObject<HTMLElement | null>,
  actions: string
): void {
  // Set by where focus lands, not where it leaves: a removed button may not report its blur.
  const inFooter = useRef(false)
  useEffect(() => {
    const landed = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null
      inFooter.current = Boolean(
        target && root.current?.contains(target) && target.closest('[data-worker-dock-footer]')
      )
    }
    document.addEventListener('focusin', landed)
    return () => document.removeEventListener('focusin', landed)
  }, [root])
  useLayoutEffect(() => {
    const active = document.activeElement
    if (inFooter.current && (!active || active === document.body || !active.isConnected)) {
      inFooter.current = false
      pill.current?.focus()
    }
  }, [actions, pill])
}
