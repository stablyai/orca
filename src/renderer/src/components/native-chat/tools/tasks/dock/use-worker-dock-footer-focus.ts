import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { focusWorkerDockPaneEditor } from './worker-dock-focus-return'

/** A header action (Stop all, Clear failed) that leaves while it holds focus hands focus to the
 *  pill, or to its pane's message box once the whole card is gone; never the page. Focus the user
 *  has already moved elsewhere is left where it is. `actions` names what the header draws now
 *  (including whether it is drawn at all); any change may remove the focused action, and so may a
 *  narrower pane, which hides Clear by width alone. */
export function useWorkerDockFooterFocus(
  root: RefObject<HTMLElement | null>,
  pill: RefObject<HTMLElement | null>,
  shown: boolean,
  actions: string
): void {
  // Set by where focus lands, not where it leaves: a removed button may not report its blur.
  const footerPane = useRef<Element | null | undefined>(undefined)
  const footerAction = useRef<Element | null>(null)
  useEffect(() => {
    const landed = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const action =
        target && root.current?.contains(target) && target.closest('[data-worker-dock-actions]')
      footerPane.current = action ? target.closest('[data-native-chat-root]') : undefined
      footerAction.current = action ? target : null
    }
    document.addEventListener('focusin', landed)
    return () => document.removeEventListener('focusin', landed)
  }, [root])
  const recover = useLatestHandler(() => {
    const active = document.activeElement
    const pane = footerPane.current
    const action = footerAction.current
    // Only an action that left (removed, or hidden by a narrower header), not focus the user moved
    // off a button still there (a press on the card's own chrome).
    const gone = !action?.isConnected || !action.checkVisibility()
    if (!gone && active !== action) {
      // The user moved focus off an action still there (a press on empty space): nothing to hand on.
      footerPane.current = undefined
      footerAction.current = null
      return
    }
    if (pane === undefined || !gone || (active && active !== document.body && active.isConnected)) {
      return
    }
    footerPane.current = undefined
    footerAction.current = null
    if (pill.current) {
      pill.current.focus()
    } else {
      focusWorkerDockPaneEditor(pane)
    }
  })
  useLayoutEffect(recover, [actions, recover])
  useEffect(() => {
    const element = root.current
    if (!shown || !element || typeof ResizeObserver === 'undefined') {
      return
    }
    // The browser moves focus off a hidden button after layout: check once it has.
    const later = () => setTimeout(recover, 0)
    const observer = new ResizeObserver(later)
    observer.observe(element)
    // Focus that leaves for nowhere (a hidden button's blur) is checked the same way.
    const left = (event: FocusEvent) => {
      if (event.relatedTarget === null) {
        later()
      }
    }
    element.addEventListener('focusout', left)
    return () => {
      observer.disconnect()
      element.removeEventListener('focusout', left)
    }
  }, [root, shown, recover])
}
