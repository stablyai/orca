import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { focusWorkerDockPaneEditor } from './worker-dock-focus-return'

/** A footer action (Stop all, Clear failed) that leaves while it holds focus hands focus to the
 *  pill, or to its pane's message box once the whole card is gone; never the page. Focus the user
 *  has already moved elsewhere is left where it is. `actions` names what the footer draws now
 *  (including whether it is drawn at all); any change may remove the focused action. */
export function useWorkerDockFooterFocus(
  root: RefObject<HTMLElement | null>,
  pill: RefObject<HTMLElement | null>,
  actions: string
): void {
  // Set by where focus lands, not where it leaves: a removed button may not report its blur.
  const footerPane = useRef<Element | null | undefined>(undefined)
  useEffect(() => {
    const landed = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null
      footerPane.current =
        target && root.current?.contains(target) && target.closest('[data-worker-dock-footer]')
          ? target.closest('[data-native-chat-root]')
          : undefined
    }
    document.addEventListener('focusin', landed)
    return () => document.removeEventListener('focusin', landed)
  }, [root])
  useLayoutEffect(() => {
    const active = document.activeElement
    const pane = footerPane.current
    if (pane === undefined || (active && active !== document.body && active.isConnected)) {
      return
    }
    footerPane.current = undefined
    if (pill.current) {
      pill.current.focus()
    } else {
      focusWorkerDockPaneEditor(pane)
    }
  }, [actions, pill])
}
