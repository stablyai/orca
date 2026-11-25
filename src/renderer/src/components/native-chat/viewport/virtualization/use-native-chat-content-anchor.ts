// Prepend anchoring by readable content. When an older page lands, the content the reader was
// looking at (marked `data-native-chat-content-anchor`) returns to its offset in the viewport.
// Every correction goes through the virtualizer's own adjustment path, so its offset stays in
// step, and the unseen-write guard is never bypassed: rows first drawn in the landing commit are
// measured after the virtualizer's own prepend write instead, and rows already drawn are
// measured again before the content is reconciled, so no later observer corrects the same
// growth a second time.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { nativeChatFindGeometry } from '../find/native-chat-find-visibility'
import type { NativeChatAlignEdge } from './use-native-chat-viewport-align'

/** Rows carry their slot key so a snapshot can tell the same row from a rekeyed one. */
const NATIVE_CHAT_ROW_KEY_ATTRIBUTE = 'data-native-chat-row-key'

export type NativeChatContentSnapshot = {
  /** Visible content from the reader's top down: its row, its offset in that row, and its offset
   *  from the viewport's top. */
  anchors: { key: string; row: string; inset: number; top: number }[]
}

/** What the window's size rule needs from the anchor: the row whose growth the anchor corrects
 *  itself while it settles; `correcting` admits only the anchor's own handed-over change. */
export type NativeChatAnchorState = {
  row: { key: string; correcting: boolean } | null
}

export type NativeChatContentAnchor = {
  /** Read the reader's content boxes; call before the prepend mutates the DOM. */
  snapshotContent: () => NativeChatContentSnapshot | null
  /** Hold this snapshot until the next layout reconciles it. */
  preserveContent: (snapshot: NativeChatContentSnapshot) => void
  /** Return the reader's content to its snapshot offset. */
  reconcileContent: () => void
}

/** Window callbacks the anchor measures through, or that end its claim on the scroll. */
type AnchoredWindowCallbacks = {
  measureRow: (node: HTMLElement | null) => void
  alignToViewportTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  cancelAlign: () => void
  scrollToEnd: () => void
  reconcileReaderScroll: (isTakingOver: boolean) => void
  consumeProgrammaticScroll: (event: Event) => boolean
}

const CONTENT_ANCHOR_SELECTOR = '[data-native-chat-content-anchor]'
const ROW_SELECTOR = `[${NATIVE_CHAT_ROW_KEY_ATTRIBUTE}]`
const WINDOW_ROW_SELECTOR = '[data-native-chat-window] > [data-index]'
const SUBPIXEL_PX = 0.5
/** An opened run's member list can still measure for a few frames after the page lands. */
const SETTLE_FRAMES = 8

function placeInRow(element: HTMLElement): { row: string; inset: number } | null {
  const row = element.closest<HTMLElement>(ROW_SELECTOR)
  const key = row?.getAttribute(NATIVE_CHAT_ROW_KEY_ATTRIBUTE)
  if (!row || !key) {
    return null
  }
  return { row: key, inset: element.getBoundingClientRect().top - row.getBoundingClientRect().top }
}

/** The reader's top visible content and everything below it, in document order. */
export function readNativeChatContentSnapshot(
  container: HTMLElement
): NativeChatContentSnapshot | null {
  const top = container.getBoundingClientRect().top
  const geometry = nativeChatFindGeometry(container)
  // Clipped inner content (a collapsed tool body) cannot hold the reader's place.
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(CONTENT_ANCHOR_SELECTOR)
  ).filter((element) => geometry.intersectsView(element))
  // The content the viewport's top edge cuts through, innermost first (a command inside its run,
  // even when mostly scrolled past); otherwise the first content below that edge.
  const crossing = candidates.filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.top <= top && rect.bottom > top
  })
  const first =
    crossing.reduce<HTMLElement | undefined>(
      (inner, element) =>
        inner && inner.getBoundingClientRect().top > element.getBoundingClientRect().top
          ? inner
          : element,
      undefined
    ) ?? candidates.find((element) => element.getBoundingClientRect().top > top)
  if (!first) {
    return null
  }
  const anchors = candidates.slice(candidates.indexOf(first)).flatMap((element) => {
    const key = element.dataset.nativeChatContentAnchor
    const place = key ? placeInRow(element) : null
    return key && place
      ? [{ key, ...place, top: element.getBoundingClientRect().top - top }]
      : []
  })
  return anchors.length > 0 ? { anchors } : null
}

/** Adds content anchoring to the transcript window; reader and jump intents drop a held snapshot. */
export function useNativeChatContentAnchor<Window extends AnchoredWindowCallbacks>(
  {
    scrollRef,
    isVisible,
    virtualizer,
    isAlignHeld,
    anchorState
  }: {
    scrollRef: React.RefObject<HTMLDivElement | null>
    isVisible: boolean
    virtualizer: Virtualizer<HTMLDivElement, Element>
    isAlignHeld: () => boolean
    anchorState: NativeChatAnchorState
  },
  transcriptWindow: Window
): Window & NativeChatContentAnchor {
  const contentSnapshot = useRef<NativeChatContentSnapshot | null>(null)
  const stopSettling = useRef<(() => void) | null>(null)
  const firstMeasurements = useRef(new Set<HTMLElement>())
  // Any reader or jump intent ends both the held snapshot and a settling correction.
  const release = useCallback(() => {
    contentSnapshot.current = null
    stopSettling.current?.()
    stopSettling.current = null
    anchorState.row = null
  }, [anchorState])
  useEffect(() => release, [release])

  // A row's ref attaches before the virtualizer's layout effect applies a landing page's scroll
  // write; measured then, the unseen-write guard would rightly refuse to compensate it.
  const measureRow = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        firstMeasurements.current.add(node)
      } else {
        virtualizer.measureElement(null)
      }
    },
    [virtualizer]
  )
  // Runs after the virtualizer's layout effect in every commit, in commit order. A landing commit
  // also measures the rows already drawn, so their growth is compensated now, before the content
  // is reconciled, rather than by a later observer delivery on top of the reconcile.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- drains whatever this commit's refs queued.
  useLayoutEffect(() => {
    const queued = firstMeasurements.current
    const landing = contentSnapshot.current !== null && scrollRef.current
    const rows = landing
      ? scrollRef.current.querySelectorAll<HTMLElement>(WINDOW_ROW_SELECTOR)
      : []
    if (queued.size === 0 && rows.length === 0) {
      return
    }
    for (const node of [...queued, ...rows]) {
      if (node.isConnected) {
        virtualizer.measureElement(node)
      }
    }
    queued.clear()
  })

  /** Moves the scroll by `delta` through the virtualizer's adjustment path, leaving the row's
   *  cached size at its measured height whichever observer saw the row's growth first. */
  const shift = useCallback(
    (anchored: { key: string; correcting: boolean }, row: HTMLElement, delta: number) => {
      const index = Number(row.dataset.index)
      if (!Number.isInteger(index) || Math.abs(delta) <= SUBPIXEL_PX) {
        return
      }
      const measured = virtualizer.options.measureElement(row, undefined, virtualizer)
      virtualizer.resizeItem(index, measured)
      anchored.correcting = true
      virtualizer.resizeItem(index, measured + delta)
      anchored.correcting = false
      virtualizer.resizeItem(index, measured)
    },
    [virtualizer]
  )

  const snapshotContent = useCallback((): NativeChatContentSnapshot | null => {
    const container = scrollRef.current
    if (!container || !isVisible || isAlignHeld()) {
      return null
    }
    return readNativeChatContentSnapshot(container)
  }, [isAlignHeld, isVisible, scrollRef])

  const preserveContent = useCallback((snapshot: NativeChatContentSnapshot) => {
    contentSnapshot.current = snapshot
  }, [])

  const reconcileContent = useCallback(() => {
    const snapshot = contentSnapshot.current
    if (!snapshot) {
      return
    }
    release()
    const container = scrollRef.current
    if (!container || !isVisible || isAlignHeld()) {
      return
    }
    // The first anchor still in its row holds the place; rekeyed or removed content falls through.
    // One pass over the drawn anchors, so falling through many removed ones stays linear.
    const drawn = new Map<string, HTMLElement>()
    for (const element of container.querySelectorAll<HTMLElement>(CONTENT_ANCHOR_SELECTOR)) {
      const key = element.dataset.nativeChatContentAnchor
      if (key && !drawn.has(key)) {
        drawn.set(key, element)
      }
    }
    for (const anchor of snapshot.anchors) {
      const node = drawn.get(anchor.key)
      const row = node?.closest<HTMLElement>(ROW_SELECTOR)
      if (!node || !row || placeInRow(node)?.row !== anchor.row) {
        continue
      }
      const anchored = { key: anchor.row, correcting: false }
      anchorState.row = anchored
      // The landing correction: whatever the page moved the content by, whole row or inside it.
      const viewportTop = container.getBoundingClientRect().top
      shift(anchored, row, node.getBoundingClientRect().top - viewportTop - anchor.top)
      // Then only the row's own later growth above the content (an opened run's members
      // measuring); any reader scroll ends this.
      let inset = placeInRow(node)?.inset ?? anchor.inset
      const hold = () => {
        const place = node.isConnected ? placeInRow(node) : null
        if (!place || place.row !== anchor.row) {
          return
        }
        const delta = place.inset - inset
        inset = place.inset
        shift(anchored, row, delta)
      }
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(hold)
        observer.observe(row)
        let frames = 0
        let frame = requestAnimationFrame(function count() {
          frames += 1
          frame = frames < SETTLE_FRAMES ? requestAnimationFrame(count) : 0
          if (frame === 0) {
            release()
          }
        })
        stopSettling.current = () => {
          cancelAnimationFrame(frame)
          observer.disconnect()
        }
      } else {
        anchorState.row = null
      }
      return
    }
  }, [anchorState, isAlignHeld, isVisible, release, scrollRef, shift])

  const {
    alignToViewportTop,
    cancelAlign,
    scrollToEnd,
    reconcileReaderScroll,
    consumeProgrammaticScroll
  } = transcriptWindow
  const alignReaderContent = useCallback(
    (element: HTMLElement, edge?: NativeChatAlignEdge) => {
      release()
      alignToViewportTop(element, edge)
    },
    [alignToViewportTop, release]
  )
  const cancelReaderAlign = useCallback(() => {
    release()
    cancelAlign()
  }, [cancelAlign, release])
  const scrollReaderToEnd = useCallback(() => {
    release()
    scrollToEnd()
  }, [release, scrollToEnd])
  const reconcileReaderTakeover = useCallback(
    (isTakingOver: boolean) => {
      if (isTakingOver) {
        release()
      }
      reconcileReaderScroll(isTakingOver)
    },
    [reconcileReaderScroll, release]
  )
  // A scroll this app did not write is the reader's (or the platform's): it owns the view now.
  const consumeReaderScroll = useCallback(
    (event: Event) => {
      const programmatic = consumeProgrammaticScroll(event)
      if (!programmatic) {
        release()
      }
      return programmatic
    },
    [consumeProgrammaticScroll, release]
  )

  return {
    ...transcriptWindow,
    measureRow,
    alignToViewportTop: alignReaderContent,
    cancelAlign: cancelReaderAlign,
    scrollToEnd: scrollReaderToEnd,
    reconcileReaderScroll: reconcileReaderTakeover,
    consumeProgrammaticScroll: consumeReaderScroll,
    snapshotContent,
    preserveContent,
    reconcileContent
  }
}
