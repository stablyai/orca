// The Items list's one view of its panel's scroller: where the visible box is, and a notice (once per frame)
// when scrolling, resizing or the list's own height moves it. Each long group reads its rows' window from it,
// so groups add no scroll listeners or observers of their own.
import { useEffect, useMemo, useRef } from 'react'

export type BotItemsViewportBox = { top: number; bottom: number; scrollTop: number }

export type BotItemsViewport = {
  /** The scroller's visible box in client coordinates and its scroll offset; null before a scroller is
   *  attached. Read once per frame for every group a notice reaches. */
  read: () => BotItemsViewportBox | null
  subscribe: (listener: () => void) => () => void
  /** Scrolls to `scrollTop`, to keep what was at the top of the view there. */
  scrollTo: (scrollTop: number) => void
}

function readBox(scroller: HTMLElement): BotItemsViewportBox {
  const box = scroller.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, scrollTop: scroller.scrollTop }
}

export function useBotItemsViewport(
  scroller: HTMLElement | null,
  list: React.RefObject<HTMLElement | null>
): BotItemsViewport {
  const listeners = useRef(new Set<() => void>())
  // This frame's box, shared by every group a notice reaches.
  const frameBox = useRef<BotItemsViewportBox | null>(null)
  const viewport = useMemo<BotItemsViewport>(
    () => ({
      read: () => (scroller ? (frameBox.current ?? readBox(scroller)) : null),
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
      scrollTo: (scrollTop) => scroller?.scrollTo({ top: scrollTop })
    }),
    [scroller]
  )
  useEffect(() => {
    if (!scroller) {
      return
    }
    let frame: number | null = null
    const notify = (): void => {
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null
          frameBox.current = readBox(scroller)
          listeners.current.forEach((listener) => listener())
          frameBox.current = null
        })
      }
    }
    scroller.addEventListener('scroll', notify, { passive: true })
    // The list's height moves a group below one that folds, grows or shrinks.
    const resized = new ResizeObserver(notify)
    resized.observe(scroller)
    if (list.current) {
      resized.observe(list.current)
    }
    notify()
    return () => {
      scroller.removeEventListener('scroll', notify)
      resized.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [scroller, list])
  return viewport
}
