import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../../shared/native-chat-turn-grouping'

export type NativeChatTurnRows = {
  /** The rows in the order the transcript draws them. */
  messages: readonly NativeChatMessage[]
  /** Each drawn row's turn, by index into `messages`. */
  turnKeys: readonly (string | undefined)[]
  liveTurnKey: string | undefined
}

/** Each row's turn, which turn is live, and the order the rows draw in, resolved once: from the
 *  turn record when the host states scopes, else by journal order. */
export function useNativeChatTurnMembership(
  messages: readonly NativeChatMessage[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  journalSubmissions: readonly AgentJournalSubmission[] | undefined
): NativeChatTurnRows {
  return useMemo(() => {
    const { turnKeys, liveTurnKey, drawOrder } = nativeChatTurnMembership(
      messages,
      journalItems ? { items: journalItems, submissions: journalSubmissions ?? [] } : null
    )
    return {
      messages: nativeChatRowsInDrawOrder(messages, drawOrder),
      turnKeys: nativeChatRowsInDrawOrder(turnKeys, drawOrder),
      liveTurnKey
    }
  }, [journalItems, journalSubmissions, messages])
}
