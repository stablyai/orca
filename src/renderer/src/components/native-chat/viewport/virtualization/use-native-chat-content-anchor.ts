// Prepend anchoring inside a row. The virtualizer already holds each row in place when an older
// page lands above it; what it cannot see is content moving within one row, as when the page
// extends the work run the reader is looking into. Readable content carries
// `data-native-chat-content-anchor`; this restores the reader's content to its offset in its row.

import { useCallback, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { nativeChatFindGeometry } from '../find/native-chat-find-visibility'
import type { NativeChatAlignEdge } from './use-native-chat-viewport-align'

/** Rows carry their slot key so a snapshot can tell the same row from a rekeyed one. */
const NATIVE_CHAT_ROW_KEY_ATTRIBUTE = 'data-native-chat-row-key'

export type NativeChatContentSnapshot = {
  /** Visible content from the reader's top down: its row and its offset from that row's top. */
  anchors: { key: string; row: string; inset: number }[]
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
  // Prefer the content crossing the viewport top, nearest that edge.
  const first = candidates
    .filter((element) => element.getBoundingClientRect().bottom > top)
    .sort(
      (left, right) =>
        Math.abs(left.getBoundingClientRect().top - top) -
        Math.abs(right.getBoundingClientRect().top - top)
    )[0]
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

/** Adds in-row content anchoring to the transcript window; reader and jump intents drop a held snapshot. */
export function useNativeChatContentAnchor<Window extends AnchoredWindowCallbacks>(
  {
    scrollRef,
    isVisible,
    virtualizer,
    isAlignHeld
  }: {
    scrollRef: React.RefObject<HTMLDivElement | null>
    isVisible: boolean
    virtualizer: Virtualizer<HTMLDivElement, Element>
    isAlignHeld: () => boolean
  },
  transcriptWindow: Window
): Window & NativeChatContentAnchor {
  const contentSnapshot = useRef<NativeChatContentSnapshot | null>(null)

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
    contentSnapshot.current = null
    const container = scrollRef.current
    if (!snapshot || !container || !isVisible || isAlignHeld()) {
      return
    }
    // The first anchor still in its row holds the place; rekeyed or removed content falls through.
    for (const anchor of snapshot.anchors) {
      const node = container.querySelector<HTMLElement>(
        `[data-native-chat-content-anchor="${CSS.escape(anchor.key)}"]`
      )
      const place = node ? placeInRow(node) : null
      if (!place || place.row !== anchor.row) {
        continue
      }
      const delta = place.inset - anchor.inset
      if (Math.abs(delta) > SUBPIXEL_PX) {
        virtualizer.scrollToOffset(container.scrollTop + delta, { behavior: 'auto' })
      }
      return
    }
  }, [isAlignHeld, isVisible, scrollRef, virtualizer])

  const { alignToViewportTop, cancelAlign, scrollToEnd, reconcileReaderScroll } = transcriptWindow
  const alignReaderContent = useCallback(
    (element: HTMLElement, edge?: NativeChatAlignEdge) => {
      contentSnapshot.current = null
      alignToViewportTop(element, edge)
    },
    [alignToViewportTop]
  )
  const cancelReaderAlign = useCallback(() => {
    contentSnapshot.current = null
    cancelAlign()
  }, [cancelAlign])
  const scrollReaderToEnd = useCallback(() => {
    contentSnapshot.current = null
    scrollToEnd()
  }, [scrollToEnd])
  const reconcileReaderTakeover = useCallback(
    (isTakingOver: boolean) => {
      if (isTakingOver) {
        contentSnapshot.current = null
      }
      reconcileReaderScroll(isTakingOver)
    },
    [reconcileReaderScroll]
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
