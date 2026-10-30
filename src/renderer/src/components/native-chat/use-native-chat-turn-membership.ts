import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../../shared/native-chat/transcript/native-chat-turn-grouping'

export type NativeChatTurnRows = {
  messages: readonly NativeChatMessage[]
  /** Each drawn row's turn, by index into `messages`. */
  turnKeys: readonly (string | undefined)[]
  liveTurnKey: string | undefined
  /** The live turn, when only its tail is loaded (`NativeChatTurnMembership.partialTurnKey`). */
  partialTurnKey?: string
  unresolvedRowIds?: ReadonlySet<string>
}

/** Resolve row order/live turn/membership once from host scopes or journal order. */
export function useNativeChatTurnMembership(
  messages: readonly NativeChatMessage[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  journalSubmissions: readonly AgentJournalSubmission[] | undefined,
  latestTurn?: AgentSessionLatestTurn | null
): NativeChatTurnRows {
  return useMemo(() => {
    const { turnKeys, liveTurnKey, drawOrder, partialTurnKey, unresolvedRowIds } =
      nativeChatTurnMembership(
        messages,
        journalItems
          ? { items: journalItems, submissions: journalSubmissions ?? [], latestTurn }
          : null
      )
    return {
      messages: nativeChatRowsInDrawOrder(messages, drawOrder),
      turnKeys: nativeChatRowsInDrawOrder(turnKeys, drawOrder),
      liveTurnKey,
      unresolvedRowIds,
      ...(partialTurnKey !== undefined ? { partialTurnKey } : {})
    }
  }, [journalItems, journalSubmissions, latestTurn, messages])
}
