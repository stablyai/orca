import { useLayoutEffect, useRef } from 'react'

// Why: a chat view released while hidden comes back where its reader left off, not at the end.
const MAX_REMEMBERED = 256

export type NativeChatReadingPosition = { messageId: string; offset: number }

const remembered = new Map<string, NativeChatReadingPosition>()

/** The first row reaching below the viewport's top, and how far the reader is into it. */
function readingPositionOf(container: HTMLElement): NativeChatReadingPosition | null {
  const top = container.getBoundingClientRect().top
  for (const slot of container.querySelectorAll<HTMLElement>('[data-index]')) {
    const rect = slot.getBoundingClientRect()
    if (rect.bottom <= top) {
      continue
    }
    const messageId = slot.querySelector<HTMLElement>('[data-native-chat-message-id]')?.dataset
      .nativeChatMessageId
    return messageId ? { messageId, offset: Math.max(0, top - rect.top) } : null
  }
  return null
}

/** The element at a remembered offset into a row, so a long message reopens at the paragraph being read. */
export function nativeChatElementAtOffset(row: HTMLElement, offset: number): HTMLElement {
  if (offset <= 0) {
    return row
  }
  const top = row.getBoundingClientRect().top + offset
  let best: HTMLElement = row
  for (const element of row.querySelectorAll<HTMLElement>('p, li, pre, table, h1, h2, h3, h4, blockquote')) {
    const elementTop = element.getBoundingClientRect().top
    if (elementTop > top) {
      break
    }
    best = element
  }
  return best
}

/** Remembers the reading position when a reader away from the end leaves; a later fresh mount jumps back to it. */
export function useNativeChatReadingPosition({
  positionKey,
  isVisible,
  ready,
  scrollRef,
  readerAtEnd,
  jumpTo
}: {
  /** One per transcript: a session's main list and each subagent's list read separately. */
  positionKey: string
  isVisible: boolean
  ready: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  readerAtEnd: () => boolean
  jumpTo: (position: NativeChatReadingPosition) => void
}): void {
  // A reveal of a view that stayed mounted already holds its offset; only a fresh mount restores.
  const freshMountRef = useRef(true)
  const latest = useRef({ readerAtEnd, jumpTo })
  latest.current = { readerAtEnd, jumpTo }
  useLayoutEffect(() => {
    if (!isVisible || !ready) {
      return
    }
    const position = remembered.get(positionKey)
    remembered.delete(positionKey)
    if (freshMountRef.current && position !== undefined) {
      latest.current.jumpTo(position)
    }
    freshMountRef.current = false
    return () => {
      const container = scrollRef.current
      const position =
        container && !latest.current.readerAtEnd() ? readingPositionOf(container) : null
      if (position === null) {
        return
      }
      remembered.set(positionKey, position)
      if (remembered.size > MAX_REMEMBERED) {
        remembered.delete(remembered.keys().next().value as string)
      }
    }
  }, [isVisible, ready, positionKey, scrollRef])
}
