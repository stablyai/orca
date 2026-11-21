// The Items list's one view of its panel's scroller: where the visible box is, and a notice (once per frame)
// when scrolling, resizing or the list's own height moves it. Each long group reads its rows' window from it,
// so groups add no scroll listeners or observers of their own, and with no group reading it nothing listens.
import { useMemo } from 'react'

export type BotItemsViewportBox = { top: number; bottom: number; scrollTop: number }

export type BotItemsViewport = {
  /** The scroller's visible box in client coordinates and its scroll offset; null before a scroller is
   *  attached. Read once per frame for every group a notice reaches. */
  read: () => BotItemsViewportBox | null
  /** The first listener starts listening to the scroller; the last one leaving stops. */
  subscribe: (listener: () => void) => () => void
  /** Scrolls to `scrollTop`, to keep what was at the top of the view there. */
  scrollTo: (scrollTop: number) => void
}

function readBox(scroller: HTMLElement): BotItemsViewportBox {
  const box = scroller.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, scrollTop: scroller.scrollTop }
}

/** Listens to `scroller` (and `list`'s size) while anyone listens here; returns the stop. */
function listenTo(
  scroller: HTMLElement,
  list: HTMLElement | null,
  onFrame: () => void
): () => void {
  let frame: number | null = null
  const notify = (): void => {
    frame ??= requestAnimationFrame(() => {
      frame = null
      onFrame()
    })
  }
  scroller.addEventListener('scroll', notify, { passive: true })
  // The list's height moves a group below one that folds, grows or shrinks.
  const resized = new ResizeObserver(notify)
  resized.observe(scroller)
  if (list) {
    resized.observe(list)
  }
  return () => {
    scroller.removeEventListener('scroll', notify)
    resized.disconnect()
    if (frame !== null) {
      cancelAnimationFrame(frame)
    }
  }
}

function createViewport(
  scroller: HTMLElement | null,
  list: React.RefObject<HTMLElement | null>
): BotItemsViewport {
  const listeners = new Set<() => void>()
  // This frame's box, shared by every group a notice reaches.
  let frameBox: BotItemsViewportBox | null = null
  let stop: (() => void) | null = null
  const onFrame = (): void => {
    if (scroller) {
      frameBox = readBox(scroller)
      listeners.forEach((listener) => listener())
      frameBox = null
    }
  }
  return {
    read: () => (scroller ? (frameBox ?? readBox(scroller)) : null),
    subscribe: (listener) => {
      listeners.add(listener)
      if (scroller && !stop) {
        stop = listenTo(scroller, list.current, onFrame)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stop) {
          stop()
          stop = null
        }
      }
    },
    scrollTo: (scrollTop) => scroller?.scrollTo({ top: scrollTop })
  }
}

export function useBotItemsViewport(
  scroller: HTMLElement | null,
  list: React.RefObject<HTMLElement | null>
): BotItemsViewport {
  return useMemo(() => createViewport(scroller, list), [scroller, list])
}
