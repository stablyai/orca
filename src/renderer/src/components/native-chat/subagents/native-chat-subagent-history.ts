import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import {
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'

function namesAgent(message: NativeChatMessage, agentId: string): boolean {
  return message.blocks.some(
    (block) => isSubagentGroupBlock(block) && block.agents.some(({ id }) => id === agentId)
  )
}

/**
 * Whether a subagent's view holds all its work: its spawning roster row is loaded ('landed'), older
 * history still holds it ('page'), or nothing loadable does ('stop'). Scanned per open, not per frame.
 */
export function nativeChatSubagentHistoryStep({
  agentId,
  conversation,
  subagentRows,
  roster,
  historyFloor
}: {
  agentId: string
  conversation: readonly NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  roster: StructuredAgentSubagentRoster | undefined
  /** The sequence the transcript's history starts from (its latest `/clear`); 0 for none. */
  historyFloor: () => number
}): 'landed' | 'page' | 'stop' {
  if (
    conversation.some((message) => namesAgent(message, agentId)) ||
    Array.from(subagentRows.values()).some((rows) =>
      rows.some(({ message }) => namesAgent(message, agentId))
    )
  ) {
    return 'landed'
  }
  const named = roster?.get(agentId)
  if (named === undefined) {
    return 'stop'
  }
  // A spawn before the latest /clear is outside this conversation: no page reaches it.
  return named.rosterPosition.sequence < historyFloor() ? 'stop' : 'page'
}
