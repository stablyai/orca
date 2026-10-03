// How a chat pane tells its transcript that the reader just sent something.

import { useCallback, useImperativeHandle, useRef } from 'react'

export type NativeChatMessageListHandle = {
  /** Bring the latest into view and follow it, wherever the reader had scrolled. */
  revealLatest: () => void
  /** For a send whose outcome arrives later: a reveal that lapses if the reader acts first. */
  holdRevealLatest: () => () => void
}

export function useNativeChatRevealLatest(): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  revealLatest: () => void
  holdRevealLatest: () => () => void
} {
  const messageListRef = useRef<NativeChatMessageListHandle>(null)
  const revealLatest = useCallback(() => messageListRef.current?.revealLatest(), [])
  const holdRevealLatest = useCallback(
    () => messageListRef.current?.holdRevealLatest() ?? (() => {}),
    []
  )
  return { messageListRef, revealLatest, holdRevealLatest }
}

/** The transcript's side: what a pane's reveal does to this list. */
export function useNativeChatMessageListHandle(
  ref: React.Ref<NativeChatMessageListHandle> | undefined,
  revealLatest: () => void,
  untilReaderActs: (act: () => void) => () => void
): void {
  useImperativeHandle(
    ref,
    () => ({ revealLatest, holdRevealLatest: () => untilReaderActs(revealLatest) }),
    [revealLatest, untilReaderActs]
  )
}
