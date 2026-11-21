// The Items list's one view of its panel's scroller: where the visible box is, and a notice (once per frame)
// when scrolling, resizing or the list's own height moves it. Each long group reads its rows' window from it,
// so groups add no scroll listeners or observers of their own.
import { useEffect, useMemo, useRef } from 'react'

export type BotItemsViewport = {
  /** The scroller's visible box in client coordinates; null before a scroller is attached. */
  read: () => { top: number; bottom: number } | null
  subscribe: (listener: () => void) => () => void
  /** Scrolls by `delta` to keep what's at the top of the view there; at the very top it lets rows flow. */
  keep: (delta: number) => void
}

export function useBotItemsViewport(
  scroller: HTMLElement | null,
  list: React.RefObject<HTMLElement | null>
): BotItemsViewport {
  const listeners = useRef(new Set<() => void>())
  const viewport = useMemo<BotItemsViewport>(
    () => ({
      read: () => {
        if (!scroller) {
          return null
        }
        const box = scroller.getBoundingClientRect()
        return { top: box.top, bottom: box.bottom }
      },
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
      keep: (delta) => {
        if (scroller && delta !== 0 && scroller.scrollTop > 0) {
          scroller.scrollTop += delta
        }
      }
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
          listeners.current.forEach((listener) => listener())
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
