import { useLayoutEffect, useMemo, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import {
  nativeChatLatestForkPoint,
  type NativeChatLatestForkPoint
} from '../../../../shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../shared/native-chat/transcript/native-chat-turn-membership'
import type { NativeChatForkSurface } from './use-native-chat-fork'

/** `/btw`: fork the chat through its newest finished response and ask there, beside the chat. */
export type NativeChatSideChat = {
  /** Why no side chat can start now; conversation reasons only while the command menu is open. */
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
    menuOpen: boolean
  }
): NativeChatSideChat | undefined {
  // The fork point walks every turn, too much for each streamed update: read at send, and for the
  // open menu only when what decides it changes.
  const latest = useRef(conversation)
  useLayoutEffect(() => {
    latest.current = conversation
  })
  const { menuOpen, agentWorking, journal } = conversation
  const menuReason = useMemo(() => {
    const point =
      menuOpen && fork?.support.kind === 'known'
        ? nativeChatLatestForkPoint(conversation, fork)
        : null
    return point && point.kind !== 'ready' ? sideChatRefusal(point) : null
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- streamed prose alone never changes it; `fork` follows the forkable responses and context floor, the journal the turns.
  }, [menuOpen, fork, agentWorking, journal?.submissions, journal?.latestTurn])
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
      notReadyReason: notReadyReason ?? menuReason,
      open: async (question) => {
        if (notReadyReason) {
          return { refused: notReadyReason }
        }
        const point = nativeChatLatestForkPoint(latest.current, fork)
        if (point.kind !== 'ready') {
          return { refused: sideChatRefusal(point) }
        }
        const outcome = await fork.request(point.throughItemId, question ? { question } : {})
        return { started: question ? outcome?.question === 'sent' : outcome?.chat !== undefined }
      }
    }
  }, [fork, menuReason])
}

function sideChatRefusal(point: Exclude<NativeChatLatestForkPoint, { kind: 'ready' }>): string {
  if (point.kind === 'reply-running') {
    return translate(
      'components.native-chat.sideChat.replyRunning',
      'Available when this reply finishes.'
    )
  }
  return translate('components.native-chat.sideChat.noReply', 'Available after the first reply.')
}
