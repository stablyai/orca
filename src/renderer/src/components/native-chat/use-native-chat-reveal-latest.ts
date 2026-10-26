import { useCallback, useImperativeHandle, useMemo, useRef } from 'react'
import { hasAskAnswer } from './native-chat-interactive-prompt'
import { nativeChatSlotCopyText } from './native-chat-message-copy-text'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
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
      // Only actual writes reveal; missing PTYs and empty answers write nothing.
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
  /** Bring a find match into view, clear of the find bar; the reader stops following the latest. */
  revealFindMatch: (match: Range, bar: DOMRectReadOnly | null) => void
  /** What the row drawing this message copies from its hover button; null when none draws it. */
  messageCopyText: (messageId: string) => string | null
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

function ignoreFindMatch(): void {}

/** Notify onSent for conversation answers; ordinary jumps to latest do not count as sends. */
export function useNativeChatMessageListHandle(
  ref: React.Ref<NativeChatMessageListHandle> | undefined,
  jumpToLatest: () => void,
  revealFindMatch: NativeChatMessageListHandle['revealFindMatch'] = ignoreFindMatch,
  onSent?: () => void,
  slots: readonly NativeChatTranscriptSlot[] = []
): void {
  useImperativeHandle(
    ref,
    () => ({
      revealLatest: () => {
        onSent?.()
        jumpToLatest()
      },
      revealFindMatch,
      messageCopyText: (messageId) => nativeChatSlotCopyText(slots, messageId)
    }),
    [jumpToLatest, revealFindMatch, onSent, slots]
  )
}
