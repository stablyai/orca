import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import type { HistoryJumpResult } from './use-native-chat-history-jump'
import { nativeChatRowDrawnAbove } from '../virtualization/use-native-chat-viewport-align'
import {
  KEPT_TRANSCRIPTS_PER_TAB,
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  writeNativeChatViewMemory
} from '../../pane/ownership/native-chat-view-memory'

// Why: a chat view released while hidden comes back where its reader left off, not at the end.
// A newer read generation can supersede the first page while the chat's read owner reactivates.
const MAX_RESTORE_ATTEMPTS = 5

export type NativeChatReadingPosition = { messageId: string; offset: number }

/**
 * The first row reaching below the viewport's top, by its message, and how far the reader is into it: a transcript
 * row, or a waiting message drawn after them. A reader past every row is held by the last one, further in.
 */
function readingPositionOf(
  container: HTMLElement,
  messageIdAt: (index: number) => string | null,
  waitingMessageIdAt: (index: number) => string | null
): NativeChatReadingPosition | null {
  const top = container.getBoundingClientRect().top
  let anchor: HTMLElement | null = null
  // Only the transcript's own rows: tool runs index their members with `data-index` too.
  for (const row of container.querySelectorAll<HTMLElement>(
    '[data-native-chat-window] > [data-index], [data-native-chat-waiting-index]'
  )) {
    anchor = row
    if (row.getBoundingClientRect().bottom > top) {
      break
    }
  }
  if (!anchor) {
    return null
  }
  const { index, nativeChatWaitingIndex } = anchor.dataset
  const messageId =
    index === undefined
      ? waitingMessageIdAt(Number.parseInt(nativeChatWaitingIndex ?? '', 10))
      : messageIdAt(Number.parseInt(index, 10))
  // Measured from where the row draws, as a landing aligns it: a continuing row draws above its own top.
  const drawnTop = anchor.getBoundingClientRect().top - nativeChatRowDrawnAbove(anchor)
  return messageId ? { messageId, offset: Math.max(0, top - drawnTop) } : null
}

/** Remembers the reading position when a reader away from the end leaves; a later fresh mount jumps back to it. */
export function useNativeChatReadingPosition({
  positionKey,
  isVisible,
  ready,
  scrollRef,
  readerAtEnd,
  messageIdAt,
  waitingMessageIdAt,
  jumpTo
}: {
  /** One per transcript: a session's main list and each subagent's list read separately. */
  positionKey: string
  isVisible: boolean
  ready: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  readerAtEnd: () => boolean
  /** The message a transcript row shows, for rows of any kind. */
  messageIdAt: (index: number) => string | null
  /** The message a waiting row shows. */
  waitingMessageIdAt: (index: number) => string | null
  jumpTo: (position: NativeChatReadingPosition, settled: (result: HistoryJumpResult) => void) => void
}): () => boolean {
  const tab = useContext(NativeChatViewTabContext)
  const key = `reading-position:${positionKey}`
  // A reveal of a view that stayed mounted already holds its offset; only a fresh mount, or one whose restore
  // failed to load history, restores.
  const freshMountRef = useRef(true)
  // The restore in flight; an effect replay (StrictMode, a hide mid-restore) keeps the bookmark and retries it.
  const restoringRef = useRef<NativeChatReadingPosition | null>(null)
  const latest = useRef({ readerAtEnd, jumpTo, messageIdAt, waitingMessageIdAt })
  useLayoutEffect(() => {
    latest.current = { readerAtEnd, jumpTo, messageIdAt, waitingMessageIdAt }
  })
  // Leaving reads the rows while they are still laid out, before a hide takes them off the page.
  useLayoutEffect(() => {
    if (!isVisible || !ready || !tab) {
      return
    }
    return () => {
      if (restoringRef.current !== null) {
        restoringRef.current = null
        return
      }
      const container = scrollRef.current
      const next =
        container && !latest.current.readerAtEnd()
          ? readingPositionOf(container, latest.current.messageIdAt, latest.current.waitingMessageIdAt)
          : null
      if (next === null && freshMountRef.current) {
        return
      }
      freshMountRef.current = false
      writeNativeChatViewMemory(tab, key, next ?? undefined, KEPT_TRANSCRIPTS_PER_TAB)
    }
  }, [isVisible, ready, tab, key, scrollRef])
  // Why passive: a reveal's passive cleanups (the history jump aborts on a visibility change) run first.
  useEffect(() => {
    if (!isVisible || !ready || !tab) {
      return
    }
    let cancelled = false
    let frame = 0
    const position = freshMountRef.current
      ? readNativeChatViewMemory<NativeChatReadingPosition>(tab, key)
      : undefined
    if (position === undefined) {
      freshMountRef.current = false
      writeNativeChatViewMemory(tab, key, undefined)
    } else {
      restoringRef.current = position
      const attempt = (tries: number): void => {
        latest.current.jumpTo(position, (result) => {
          if (cancelled) {
            return
          }
          if (result === 'superseded' && tries < MAX_RESTORE_ATTEMPTS) {
            frame = requestAnimationFrame(() => attempt(tries + 1))
            return
          }
          restoringRef.current = null
          if (result === 'failed') {
            // History didn't load; the bookmark stays for the next reveal.
            return
          }
          // Landed, gone, or the reader moved on: the bookmark has done its job.
          freshMountRef.current = false
          if (readNativeChatViewMemory(tab, key) === position) {
            writeNativeChatViewMemory(tab, key, undefined)
          }
        })
      }
      attempt(1)
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [isVisible, ready, tab, key])
  return useCallback(() => restoringRef.current !== null, [])
}
