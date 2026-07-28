import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'

/**
 * Restores mouse-wheel scrolling for a scroll container inside a portaled
 * popover, and hands back the node.
 *
 * Radix Dialog applies react-remove-scroll, which calls preventDefault() on
 * wheel events for elements outside the dialog's DOM tree — the scrollbar
 * renders and drags fine, but the wheel does nothing. A non-passive listener on
 * the container scrolls it manually instead. `ui/command`'s CommandList carries
 * the same shim; this is the equivalent for a plain scroll pane.
 */
export function useWheelScrollable<T extends HTMLElement>(): {
  ref: MutableRefObject<T | null>
  setNode: (node: T | null) => void
} {
  const ref = useRef<T | null>(null)
  const detachRef = useRef<(() => void) | null>(null)

  const setNode = useCallback((node: T | null): void => {
    detachRef.current?.()
    detachRef.current = null
    ref.current = node
    if (!node) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      if (node.scrollHeight <= node.clientHeight) {
        return
      }
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * node.clientHeight
            : event.deltaY
      const max = node.scrollHeight - node.clientHeight
      const next = Math.max(0, Math.min(max, node.scrollTop + delta))
      if (next === node.scrollTop) {
        // At an edge: let the event bubble so an ancestor can take the scroll.
        return
      }
      event.preventDefault()
      event.stopPropagation()
      node.scrollTop = next
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    detachRef.current = () => node.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => () => detachRef.current?.(), [])

  return { ref, setNode }
}
