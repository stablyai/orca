// Prepend anchoring by readable content. The virtualizer holds rows in place when an older page
// lands above them; it cannot see content moving inside the row the reader is in, as when the page
// grows an opened work run above the command being read. Readable content carries
// `data-native-chat-content-anchor`; growth above it inside its row is handed to the virtualizer
// as that row's size change, so one owner corrects the scroll position, in sync with its own.

import { useCallback, useEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { nativeChatFindGeometry } from '../find/native-chat-find-visibility'
import type { NativeChatAlignEdge } from './use-native-chat-viewport-align'

/** Rows carry their slot key so a snapshot can tell the same row from a rekeyed one. */
const NATIVE_CHAT_ROW_KEY_ATTRIBUTE = 'data-native-chat-row-key'

export type NativeChatContentSnapshot = {
  /** Visible content from the reader's top down: its row and its offset from that row's top. */
  anchors: { key: string; row: string; inset: number }[]
}

/** What the window's size rule needs from the anchor. `landing`: a page is being drawn in this
 *  commit and the virtualizer's own scroll write for it has not landed yet. `row`: the row whose
 *  in-row growth the anchor corrects; `correcting` admits that one handed-over change. */
export type NativeChatAnchorState = {
  landing: boolean
  row: { key: string; correcting: boolean } | null
}

export type NativeChatContentAnchor = {
  /** Read the reader's content boxes; call before the prepend mutates the DOM. */
  snapshotContent: () => NativeChatContentSnapshot | null
  /** Hold this snapshot until the next layout reconciles it. */
  preserveContent: (snapshot: NativeChatContentSnapshot) => void
  /** Undo content movement inside the anchored row. */
  reconcileContent: () => void
}

/** Window callbacks that end the reader's claim on a held snapshot. */
type AnchoredWindowCallbacks = {
  alignToViewportTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  cancelAlign: () => void
  scrollToEnd: () => void
  reconcileReaderScroll: (isTakingOver: boolean) => void
}

const CONTENT_ANCHOR_SELECTOR = '[data-native-chat-content-anchor]'
const ROW_SELECTOR = `[${NATIVE_CHAT_ROW_KEY_ATTRIBUTE}]`
const SUBPIXEL_PX = 0.5
/** Rows drawn by the page (and an opened run's member list) still measure for a few frames. */
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
    return key && place ? [{ key, ...place }] : []
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
  // Any reader or jump intent ends both the held snapshot and a settling correction.
  const release = useCallback(() => {
    contentSnapshot.current = null
    stopSettling.current?.()
    stopSettling.current = null
    anchorState.row = null
  }, [anchorState])
  useEffect(() => release, [release])

  const snapshotContent = useCallback((): NativeChatContentSnapshot | null => {
    const container = scrollRef.current
    // Called before a page's rows mutate; the commit's reconcile ends the landing.
    anchorState.landing = true
    if (!container || !isVisible || isAlignHeld()) {
      return null
    }
    return readNativeChatContentSnapshot(container)
  }, [anchorState, isAlignHeld, isVisible, scrollRef])

  const preserveContent = useCallback((snapshot: NativeChatContentSnapshot) => {
    contentSnapshot.current = snapshot
  }, [])

  const reconcileContent = useCallback(() => {
    anchorState.landing = false
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
    for (const anchor of snapshot.anchors) {
      const node = container.querySelector<HTMLElement>(
        `[data-native-chat-content-anchor="${CSS.escape(anchor.key)}"]`
      )
      const row = node?.closest<HTMLElement>(ROW_SELECTOR)
      if (!node || !row || placeInRow(node)?.row !== anchor.row) {
        continue
      }
      const anchored = { key: anchor.row, correcting: false }
      anchorState.row = anchored
      let inset = anchor.inset
      const hold = () => {
        const place = node.isConnected ? placeInRow(node) : null
        const index = Number(row.dataset.index)
        const size = virtualizer.measurementsCache[index]?.size
        if (!place || place.row !== anchor.row || size === undefined) {
          return
        }
        const delta = place.inset - inset
        inset = place.inset
        if (Math.abs(delta) > SUBPIXEL_PX) {
          // The virtualizer shifts by exactly this and keeps its offset in step for later rows.
          anchored.correcting = true
          virtualizer.resizeItem(index, size + delta)
          anchored.correcting = false
        }
      }
      hold()
      // Resize callbacks run before paint, so later growth inside the row is undone in its frame.
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
  }, [anchorState, isAlignHeld, isVisible, release, scrollRef, virtualizer])

  const { alignToViewportTop, cancelAlign, scrollToEnd, reconcileReaderScroll } = transcriptWindow
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

  return {
    ...transcriptWindow,
    alignToViewportTop: alignReaderContent,
    cancelAlign: cancelReaderAlign,
    scrollToEnd: scrollReaderToEnd,
    reconcileReaderScroll: reconcileReaderTakeover,
    snapshotContent,
    preserveContent,
    reconcileContent
  }
}
