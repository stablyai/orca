import { useLayoutEffect, useRef } from 'react'

// Why: a chat view released while hidden comes back where its reader left off, not at the end.
const MAX_REMEMBERED = 256
// A newer read generation can supersede the first page while the chat's read owner reactivates.
const MAX_RESTORE_ATTEMPTS = 5

export type NativeChatReadingPosition = { messageId: string; offset: number }
type RestoreResult = 'landed' | 'missing' | 'aborted' | 'superseded'

const remembered = new Map<string, NativeChatReadingPosition>()

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
  jumpTo: (position: NativeChatReadingPosition, settled: (result: RestoreResult) => void) => void
}): void {
  // A reveal of a view that stayed mounted already holds its offset; only a fresh mount restores.
  const freshMountRef = useRef(true)
  const latest = useRef({ readerAtEnd, jumpTo, messageIdAt })
  latest.current = { readerAtEnd, jumpTo, messageIdAt }
  useLayoutEffect(() => {
    if (!isVisible || !ready) {
      return
    }
    let cancelled = false
    let frame = 0
    const position = freshMountRef.current ? remembered.get(positionKey) : undefined
    freshMountRef.current = false
    if (position === undefined) {
      remembered.delete(positionKey)
    } else {
      const attempt = (tries: number): void => {
        latest.current.jumpTo(position, (result) => {
          if (cancelled) {
            return
          }
          if (result === 'superseded' && tries < MAX_RESTORE_ATTEMPTS) {
            frame = requestAnimationFrame(() => attempt(tries + 1))
            return
          }
          // Landed, gone, or the reader moved on: the bookmark has done its job.
          if (remembered.get(positionKey) === position) {
            remembered.delete(positionKey)
          }
        })
      }
      attempt(1)
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      const container = scrollRef.current
      const next =
        container && !latest.current.readerAtEnd()
          ? readingPositionOf(container, latest.current.messageIdAt)
          : null
      if (next === null) {
        remembered.delete(positionKey)
        return
      }
      remembered.delete(positionKey)
      remembered.set(positionKey, next)
      if (remembered.size > MAX_REMEMBERED) {
        remembered.delete(remembered.keys().next().value as string)
      }
    }
  }, [isVisible, ready, positionKey, scrollRef])
}
