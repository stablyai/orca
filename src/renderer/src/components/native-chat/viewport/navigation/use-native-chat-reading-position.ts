import { useLayoutEffect, useRef } from 'react'

// Why: a chat view released while hidden comes back where its reader left off, not at the end.
const MAX_REMEMBERED = 256
const remembered = new Map<string, string>()

function topVisibleMessageId(container: HTMLElement): string | null {
  const top = container.getBoundingClientRect().top
  for (const row of container.querySelectorAll<HTMLElement>('[data-native-chat-message-id]')) {
    if (row.getBoundingClientRect().bottom > top) {
      return row.dataset.nativeChatMessageId ?? null
    }
  }
  return null
}

/** Remembers the top message when a reader away from the end leaves; a later fresh mount jumps back to it. */
export function useNativeChatReadingPosition({
  sessionKey,
  isVisible,
  ready,
  scrollRef,
  readerAtEnd,
  jumpTo
}: {
  sessionKey: string
  isVisible: boolean
  ready: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  readerAtEnd: () => boolean
  jumpTo: (messageId: string) => void
}): void {
  // A reveal of a view that stayed mounted already holds its offset; only a fresh mount restores.
  const freshMountRef = useRef(true)
  const latest = useRef({ readerAtEnd, jumpTo })
  latest.current = { readerAtEnd, jumpTo }
  useLayoutEffect(() => {
    if (!isVisible || !ready) {
      return
    }
    const messageId = remembered.get(sessionKey)
    remembered.delete(sessionKey)
    if (freshMountRef.current && messageId !== undefined) {
      latest.current.jumpTo(messageId)
    }
    freshMountRef.current = false
    return () => {
      const container = scrollRef.current
      const messageId =
        container && !latest.current.readerAtEnd() ? topVisibleMessageId(container) : null
      if (messageId === null) {
        return
      }
      remembered.set(sessionKey, messageId)
      if (remembered.size > MAX_REMEMBERED) {
        remembered.delete(remembered.keys().next().value as string)
      }
    }
  }, [isVisible, ready, sessionKey, scrollRef])
}
