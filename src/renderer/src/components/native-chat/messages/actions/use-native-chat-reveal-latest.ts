import { useCallback, useImperativeHandle, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { hasAskAnswer } from '../../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import { nativeChatScrollsToLatestOnSend } from '../../../../../../shared/native-chat/native-chat-appearance-settings'
import { nativeChatSlotCopyText } from './native-chat-message-copy-text'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type { NativeChatInteractiveSend } from '../../session/terminal/send/use-native-chat-interactive-send'

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
      sendRawVerified: (raw, requireStartupDialog) => {
        if (targetPtyId) {
          revealLatest()
        }
        return sendRawVerified(raw, requireStartupDialog)
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
  /** After the reader's own send, follow the latest; with that setting off, only for a reader at the end. */
  revealLatest: (readerWasAtEnd?: boolean) => void
  readerAtEnd: () => boolean
  /** Bring a find match into view, clear of the find bar; the reader stops following the latest. */
  revealFindMatch: (match: Range, bar: DOMRectReadOnly | null) => void
  /** What the row drawing this message copies from its Copy button; null when none draws it. */
  messageCopyText: (messageId: string) => string | null
}

/** This pane's own transcript; an unmounted pane's reveal reaches nothing. */
export function useNativeChatRevealLatest(): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  revealLatest: () => void
  captureRevealLatest: () => () => void
} {
  const messageListRef = useRef<NativeChatMessageListHandle>(null)
  const reveal = useCallback((readerWasAtEnd?: boolean) => {
    try {
      messageListRef.current?.revealLatest(readerWasAtEnd)
    } catch (error) {
      // Navigation never stops the send that asked for it.
      console.error('Could not reveal the submitted chat content', error)
    }
  }, [])
  const revealLatest = useCallback(() => reveal(), [reveal])
  // A reveal that waits for the host reads the reader at the press, before the send's echo moves the end.
  const captureRevealLatest = useCallback(() => {
    const readerWasAtEnd = messageListRef.current?.readerAtEnd()
    return () => reveal(readerWasAtEnd)
  }, [reveal])
  return { messageListRef, revealLatest, captureRevealLatest }
}

/** Own sends follow the latest; with that setting off, only a reader who was at the end does. */
export function useNativeChatMessageListHandle(
  ref: React.Ref<NativeChatMessageListHandle> | undefined,
  {
    readerAtEnd,
    beginNavigation,
    scrollToBottom,
    onSent,
    revealFindMatch,
    slots
  }: Pick<NativeChatMessageListHandle, 'readerAtEnd' | 'revealFindMatch'> & {
    beginNavigation: () => void
    scrollToBottom: (reason: 'send') => void
    /** The reader answered, whether or not the view moves. */
    onSent: () => void
    slots: readonly NativeChatTranscriptSlot[]
  }
): void {
  const revealLatest = useCallback(
    (readerWasAtEnd = readerAtEnd()) => {
      onSent()
      if (!nativeChatScrollsToLatestOnSend(useAppStore.getState().settings) && !readerWasAtEnd) {
        return
      }
      beginNavigation()
      scrollToBottom('send')
    },
    [beginNavigation, onSent, readerAtEnd, scrollToBottom]
  )
  useImperativeHandle(
    ref,
    () => ({
      revealLatest,
      readerAtEnd,
      revealFindMatch,
      messageCopyText: (messageId) => nativeChatSlotCopyText(slots, messageId)
    }),
    [readerAtEnd, revealLatest, revealFindMatch, slots]
  )
}
