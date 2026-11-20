import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import type { HistoryJumpResult } from './use-native-chat-history-jump'
import {
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  writeNativeChatViewMemory
} from '../../pane/ownership/native-chat-view-memory'

// Why: a chat view released while hidden comes back where its reader left off, not at the end.
// A newer read generation can supersede the first page while the chat's read owner reactivates.
const MAX_RESTORE_ATTEMPTS = 5

export type NativeChatReadingPosition = { messageId: string; offset: number }

/** The first row reaching below the viewport's top, by its message, and how far the reader is into it. */
function readingPositionOf(
  container: HTMLElement,
  messageIdAt: (index: number) => string | null
): NativeChatReadingPosition | null {
  const top = container.getBoundingClientRect().top
  for (const row of container.querySelectorAll<HTMLElement>('[data-index]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom <= top) {
      continue
    }
    const messageId = messageIdAt(Number.parseInt(row.dataset.index ?? '', 10))
    return messageId ? { messageId, offset: Math.max(0, top - rect.top) } : null
  }
  return null
}

/** Remembers the reading position when a reader away from the end leaves; a later fresh mount jumps back to it. */
export function useNativeChatReadingPosition({
  positionKey,
  isVisible,
  ready,
  scrollRef,
  readerAtEnd,
  messageIdAt,
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
  jumpTo: (position: NativeChatReadingPosition, settled: (result: HistoryJumpResult) => void) => void
}): () => boolean {
  const tab = useContext(NativeChatViewTabContext)
  const key = `reading-position:${positionKey}`
  // A reveal of a view that stayed mounted already holds its offset; only a fresh mount, or one whose restore
  // failed to load history, restores.
  const freshMountRef = useRef(true)
  // The restore in flight; an effect replay (StrictMode, a hide mid-restore) keeps the bookmark and retries it.
  const restoringRef = useRef<NativeChatReadingPosition | null>(null)
  const latest = useRef({ readerAtEnd, jumpTo, messageIdAt })
  useLayoutEffect(() => {
    latest.current = { readerAtEnd, jumpTo, messageIdAt }
  })
  useLayoutEffect(() => {
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
      if (restoringRef.current !== null) {
        restoringRef.current = null
        return
      }
      const container = scrollRef.current
      const next =
        container && !latest.current.readerAtEnd()
          ? readingPositionOf(container, latest.current.messageIdAt)
          : null
      if (next === null && freshMountRef.current) {
        return
      }
      freshMountRef.current = false
      writeNativeChatViewMemory(tab, key, next ?? undefined)
    }
  }, [isVisible, ready, tab, key, scrollRef])
  return useCallback(() => restoringRef.current !== null, [])
}
