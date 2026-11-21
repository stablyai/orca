import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentSessionLatestTurn } from '../../../../../../shared/agent-session/agent-session-wire'
import { nativeChatTurnMembership } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-grouping'
import {
  projectionBesideStreamedText,
  rowsBesideStreamedText
} from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

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
  // Membership reads message order and turns, never reply text, so it holds while one streams.
  const structure = projectionBesideStreamedText(messages)
  const items = journalItems && rowsBesideStreamedText(journalItems)
  const membership = useMemo(() => {
    const { turnKeys, liveTurnKey, drawOrder, partialTurnKey, unresolvedRowIds } =
      nativeChatTurnMembership(
        structure,
        items ? { items, submissions: journalSubmissions ?? [], latestTurn } : null
      )
    return {
      drawOrder,
      turnKeys: nativeChatRowsInDrawOrder(turnKeys, drawOrder),
      liveTurnKey,
      unresolvedRowIds,
      ...(partialTurnKey !== undefined ? { partialTurnKey } : {})
    }
  }, [items, journalSubmissions, latestTurn, structure])
  return useMemo(() => {
    const { drawOrder, ...turns } = membership
    return { ...turns, messages: nativeChatRowsInDrawOrder(messages, drawOrder) }
  }, [membership, messages])
}
