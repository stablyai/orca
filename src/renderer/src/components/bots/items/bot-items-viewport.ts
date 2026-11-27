// The Items list's one view of its panel's scroller: where the visible box is, and a notice (once per frame)
// when scrolling, resizing or the list's own height moves it. Each long group reads its rows' window from it,
// so groups add no scroll listeners or observers of their own, and with no group reading it nothing listens.
import { useMemo } from 'react'
import { flushSync } from 'react-dom'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '../../terminal-pane/viewport/visibility/stale-document-visibility'

/** Marks the scroller an Items list windows against, so the list finds it as it mounts. */
export const BOT_ITEMS_SCROLLER_ATTR = 'data-bot-items-scroller'

/** The scroller's visible box in client coordinates, and how far it is scrolled. */
export type BotItemsViewportBox = { top: number; bottom: number; scrolled: number }

/** A group's response to a notice: what it would change, applied with every other group's; null for nothing. */
export type BotItemsViewportListener = () => (() => void) | null

export type BotItemsViewport = {
  /** The scroller's visible box in client coordinates; null before a scroller is
   *  attached. Read once per frame for every group a notice reaches. */
  read: () => BotItemsViewportBox | null
  /** This notice is only a scroll: groups' places in the scrolled content are as last measured. */
  scrollOnly: () => boolean
  /** The first listener starts listening to the scroller; the last one leaving stops. */
  subscribe: (listener: BotItemsViewportListener) => () => void
  /** Notifies every listener now, once per commit: the list's groups changed shape, which can move a
   *  group into view without the list changing height. */
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
  return { top: box.top, bottom: box.bottom, scrolled: scroller.scrollTop }
}

/** Listens to `scroller` (and `list`'s size) while anyone listens here; returns the stop. */
function listenTo(
  scroller: HTMLElement,
  list: HTMLElement | null,
  onFrame: (scrollOnly: boolean, animationFrame: boolean) => void
): () => void {
  let frame: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // `byUser`: a scroll, which a hidden window never gets, so one wrongly left `hidden` (after display
  // wake, before any click or key proves it) measures too.
  let byUser = false
  // Anything but a scroll (a resize, the window showing) may have moved the groups in the content.
  let shaped = false
  const run = (): void => {
    frame = null
    timer = null
    if (byUser || !botItemsDocumentHidden()) {
      onFrame(!shaped, true)
    }
    byUser = false
    shaped = false
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
  const notify = (): void => {
    shaped = true
    schedule()
  }
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
  const listeners = new Set<BotItemsViewportListener>()
  let scroller: HTMLElement | null = null
  let list: HTMLElement | null = null
  // This frame's box, shared by every group a notice reaches.
  let frameBox: BotItemsViewportBox | null = null
  let stop: (() => void) | null = null
  let flushed = false
  let layoutPending = false
  let frameScrollOnly = false
  const onFrame = (scrollOnly = false, fromFrame = false): void => {
    if (scroller) {
      frameScrollOnly = scrollOnly && !layoutPending
      layoutPending = false
      frameBox = readBox(scroller)
      const changes: (() => void)[] = []
      listeners.forEach((listener) => {
        const change = listener()
        if (change) {
          changes.push(change)
        }
      })
      const apply = (): void => changes.forEach((change) => change())
      // Rows a scroll or resize frame brings into view commit, every group's in one, before it paints.
      if (changes.length > 0) {
        void (fromFrame ? flushSync(apply) : apply())
      }
      frameBox = null
      frameScrollOnly = false
    }
  }
  const listen = (): void => {
    stop?.()
    stop = scroller && listeners.size > 0 ? listenTo(scroller, list, onFrame) : null
  }
  return {
    read: () => (scroller ? (frameBox ?? readBox(scroller)) : null),
    scrollOnly: () => frameScrollOnly,
    subscribe: (listener) => {
      listeners.add(listener)
      if (!stop) {
        listen()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          layoutPending = false
          listen()
        }
      }
    },
    flush: () => {
      // Every group changing in one commit flushes; the first measures them all, after every change is in.
      // Before the scroller attaches there is nothing to measure; its attach measures.
      if (!scroller || listeners.size === 0) {
        return
      }
      if (botItemsDocumentHidden()) {
        // A scroll can arrive before visibility recovers. It must measure the new layout.
        layoutPending = true
        return
      }
      if (flushed) {
        return
      }
      flushed = true
      queueMicrotask(() => {
        flushed = false
      })
      onFrame()
    },
    attach: (nextScroller, nextList) => {
      if (nextScroller !== scroller || nextList !== list) {
        if (nextScroller !== scroller) {
          layoutPending = false
        }
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
