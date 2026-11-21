// The Items list's one view of its panel's scroller: where the visible box is, and a notice (once per frame)
// when scrolling, resizing or the list's own height moves it. Each long group reads its rows' window from it,
// so groups add no scroll listeners or observers of their own, and with no group reading it nothing listens.
import { useMemo } from 'react'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '../../terminal-pane/viewport/visibility/stale-document-visibility'

/** Marks the scroller an Items list windows against, so the list finds it as it mounts. */
export const BOT_ITEMS_SCROLLER_ATTR = 'data-bot-items-scroller'

export type BotItemsViewportBox = { top: number; bottom: number }

export type BotItemsViewport = {
  /** The scroller's visible box in client coordinates; null before a scroller is
   *  attached. Read once per frame for every group a notice reaches. */
  read: () => BotItemsViewportBox | null
  /** The first listener starts listening to the scroller; the last one leaving stops. */
  subscribe: (listener: () => void) => () => void
  /** Notifies every listener now: the list's groups changed shape, which can move a group into view
   *  without the list changing height. */
  flush: () => void
  /** The scroller to read and the list whose height moves the groups; null to let them go. Changing
   *  them leaves the viewport the same object, so nothing reading it renders again for it. */
  attach: (scroller: HTMLElement | null, list: HTMLElement | null) => void
}

/** Hidden for measuring: not after macOS display wake, when Chromium can stay `hidden` while the
 *  window takes input (see stale-document-visibility). */
export function botItemsDocumentHidden(): boolean {
  return document.hidden && !isDocumentVisibilityProvenStale()
}

function readBox(scroller: HTMLElement): BotItemsViewportBox {
  const box = scroller.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom }
}

/** Listens to `scroller` (and `list`'s size) while anyone listens here; returns the stop. */
function listenTo(
  scroller: HTMLElement,
  list: HTMLElement | null,
  onFrame: () => void
): () => void {
  let frame: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // `byUser`: a scroll, which a hidden window never gets, so one wrongly left `hidden` (after display
  // wake, before any click or key proves it) measures too.
  let byUser = false
  const run = (): void => {
    frame = null
    timer = null
    if (byUser || !botItemsDocumentHidden()) {
      onFrame()
    }
    byUser = false
  }
  const schedule = (): void => {
    // A hidden window measures as it shows again. One wrongly left `hidden` gets no frames, and one
    // asked for just before may never come, so it measures on a timer instead.
    if (!byUser && botItemsDocumentHidden()) {
      return
    }
    if (document.hidden && frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    if (frame !== null || timer !== null) {
      return
    }
    if (document.hidden) {
      timer = setTimeout(run, 0)
    } else {
      frame = requestAnimationFrame(run)
    }
  }
  const notify = (): void => schedule()
  const scrolled = (): void => {
    byUser = true
    schedule()
  }
  scroller.addEventListener('scroll', scrolled, { passive: true })
  // A hidden window measures nothing, so showing it again measures what changed meanwhile.
  const shown = (): void => {
    if (!document.hidden) {
      notify()
    }
  }
  document.addEventListener('visibilitychange', shown)
  const stopStale = registerStaleDocumentVisibilityRecovery(notify)
  // The list's height moves a group below one that folds, grows or shrinks.
  const resized = new ResizeObserver(notify)
  resized.observe(scroller)
  if (list) {
    resized.observe(list)
  }
  return () => {
    scroller.removeEventListener('scroll', scrolled)
    document.removeEventListener('visibilitychange', shown)
    resized.disconnect()
    stopStale()
    if (frame !== null) {
      cancelAnimationFrame(frame)
    }
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

function createViewport(): BotItemsViewport {
  const listeners = new Set<() => void>()
  let scroller: HTMLElement | null = null
  let list: HTMLElement | null = null
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
  const listen = (): void => {
    stop?.()
    stop = scroller && listeners.size > 0 ? listenTo(scroller, list, onFrame) : null
  }
  return {
    read: () => (scroller ? (frameBox ?? readBox(scroller)) : null),
    subscribe: (listener) => {
      listeners.add(listener)
      if (!stop) {
        listen()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          listen()
        }
      }
    },
    flush: () => {
      if (listeners.size > 0 && !botItemsDocumentHidden()) {
        onFrame()
      }
    },
    attach: (nextScroller, nextList) => {
      if (nextScroller !== scroller || nextList !== list) {
        scroller = nextScroller
        list = nextList
        listen()
      }
    }
  }
}

/** One per list, for its lifetime: the list attaches its scroller once both are in the page. */
export function useBotItemsViewport(): BotItemsViewport {
  return useMemo(() => createViewport(), [])
}
