import { useLayoutEffect, useMemo, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { nativeChatLatestForkPoint } from '../../../../shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../shared/native-chat/transcript/native-chat-turn-membership'
import type { NativeChatForkSurface } from './use-native-chat-fork'

/** `/btw`: fork the chat through its newest finished response and ask there, beside the chat. */
export type NativeChatSideChat = {
  /** Why no side chat can start yet, whatever the conversation holds. */
  notReadyReason: string | null
  /** Starts one; the reason when it can't start from this conversation now, else whether it started
   *  (with a question: whether the question went out). */
  open: (question: string) => Promise<{ refused: string } | { started: boolean }>
}

/** Undefined where Orca can't fork this chat, so `/btw` stays the agent's. */
export function useNativeChatSideChat(
  fork: NativeChatForkSurface | undefined,
  conversation: {
    messages: readonly NativeChatMessage[]
    journal: NativeChatTurnJournal | null
    agentWorking: boolean
  }
): NativeChatSideChat | undefined {
  // Read at send: the fork point walks every turn, too much for each streamed update.
  const latest = useRef(conversation)
  useLayoutEffect(() => {
    latest.current = conversation
  })
  return useMemo(() => {
    if (!fork) {
      return undefined
    }
    const notReadyReason =
      fork.support.kind === 'unknown'
        ? translate(
            'components.native-chat.sideChat.notReady',
            'Side chats are not ready yet. Try again in a moment.'
          )
        : null
    return {
      notReadyReason,
      open: async (question) => {
        if (notReadyReason) {
          return { refused: notReadyReason }
        }
        const point = nativeChatLatestForkPoint(latest.current, fork)
        if (point.kind === 'reply-running') {
          return {
            refused: translate(
              'components.native-chat.sideChat.replyRunning',
              'Available when this reply finishes.'
            )
          }
        }
        if (point.kind === 'no-reply') {
          return {
            refused: translate(
              'components.native-chat.sideChat.noReply',
              'Available after the first reply.'
            )
          }
        }
        const outcome = await fork.request(point.throughItemId, question ? { question } : {})
        return { started: question ? outcome?.questionSent === true : outcome?.chat !== undefined }
      }
    }
  }, [fork])
}
