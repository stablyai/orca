// How a chat pane tells its transcript that the reader just sent something.

import { useCallback, useImperativeHandle, useMemo, useRef } from 'react'
import { hasAskAnswer } from './native-chat-interactive-prompt'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

/** Answers and approval choices reveal at the press; Stop and dismissing a prompt do not. */
export function useNativeChatInteractiveSendReveal(
  {
    sendAnswer,
    sendRaw,
    sendRawVerified,
    cancelPending,
    cancelAsk,
    cancel
  }: NativeChatInteractiveSend,
  targetPtyId: string | null,
  revealLatest: () => void
): NativeChatInteractiveSend {
  return useMemo<NativeChatInteractiveSend>(
    () => ({
      // Only what is written moves the reader: no terminal, or an empty answer, writes nothing.
      sendAnswer: (prompt, selections, onDeliverySettled) => {
        if (targetPtyId && hasAskAnswer(prompt, selections)) {
          revealLatest()
        }
        return sendAnswer(prompt, selections, onDeliverySettled)
      },
      sendRaw,
      sendRawVerified: (raw) => {
        if (targetPtyId) {
          revealLatest()
        }
        return sendRawVerified(raw)
      },
      cancelPending,
      cancelAsk,
      cancel
    }),
    [
      cancel,
      cancelAsk,
      cancelPending,
      revealLatest,
      sendAnswer,
      sendRaw,
      sendRawVerified,
      targetPtyId
    ]
  )
}

export type NativeChatMessageListHandle = {
  /** Bring the latest into view and follow it, wherever the reader had scrolled. */
  revealLatest: () => void
}

/** This pane's own transcript; an unmounted pane's reveal reaches nothing. */
export function useNativeChatRevealLatest(): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  revealLatest: () => void
} {
  const messageListRef = useRef<NativeChatMessageListHandle>(null)
  const revealLatest = useCallback(() => {
    try {
      messageListRef.current?.revealLatest()
    } catch (error) {
      // Navigation never stops the send that asked for it.
      console.error('Could not reveal the submitted chat content', error)
    }
  }, [])
  return { messageListRef, revealLatest }
}

/** The transcript's side: what a pane's reveal does to this list. */
export function useNativeChatMessageListHandle(
  ref: React.Ref<NativeChatMessageListHandle> | undefined,
  revealLatest: () => void
): void {
  useImperativeHandle(ref, () => ({ revealLatest }), [revealLatest])
}
