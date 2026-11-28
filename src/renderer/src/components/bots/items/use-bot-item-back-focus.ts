// Back from an item: its pane goes, and with it the focus. The row Back returns to takes focus as it mounts
// or draws; until one does, or when no row can (every row filtered out or gone), the list's scroller holds it,
// so keys still reach the panel rather than the page.
import { useLayoutEffect, useRef, type RefObject } from 'react'

export function useBotItemBackFocus(
  paneShown: boolean,
  scroller: RefObject<HTMLElement | null>
): void {
  const wasShown = useRef(paneShown)
  useLayoutEffect(() => {
    const left = wasShown.current && !paneShown
    wasShown.current = paneShown
    const active = document.activeElement
    if (left && (active === null || active === document.body)) {
      scroller.current?.focus({ preventScroll: true })
    }
  }, [paneShown, scroller])
}
