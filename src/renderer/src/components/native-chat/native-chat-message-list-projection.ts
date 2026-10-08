import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  projectNativeChatTranscript,
  type NativeChatSubagentRow,
  type NativeChatTranscriptProjection
} from '../../../../shared/native-chat-transcript-projection'
import type { NativeChatTurnJournal } from '../../../../shared/native-chat-turn-membership'
import { compareMessages } from './native-chat-session-assembler'

function sameMessage(left: NativeChatMessage, right: NativeChatMessage): boolean {
  // Folding only clones the assistant rows that absorb a tool run; every other row
  // comes back as the input object, so most rows settle without a field scan.
  if (left === right) {
    return true
  }
  const keys = Object.keys(left) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && (key === 'blocks' || left[key] === right[key])
    ) &&
    left.blocks.length === right.blocks.length &&
    left.blocks.every((block, index) => block === right.blocks[index])
  )
}

function sameRows<T>(
  left: readonly T[] | undefined,
  right: readonly T[],
  same: (a: T, b: T) => boolean
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((item, index) => same(item, right[index]!))
  )
}

const sameSubagentRow = (a: NativeChatSubagentRow, b: NativeChatSubagentRow): boolean =>
  a.message === b.message && a.turnKey === b.turnKey

export function createNativeChatMessageListProjection(): (
  messages: NativeChatMessage[],
  journal?: NativeChatTurnJournal | null
) => NativeChatTranscriptProjection {
  let previous: NativeChatTranscriptProjection = { conversation: [], subagentRows: new Map() }
  let byId = new Map<string, NativeChatMessage>()
  return (messages, journal) => {
    const projected = projectNativeChatTranscript(messages, compareMessages, journal)
    // Folding clones historical tool runs even when every contributing block is unchanged.
    const settle = (message: NativeChatMessage): NativeChatMessage => {
      const prior = byId.get(message.id)
      return prior && sameMessage(prior, message) ? prior : message
    }
    const conversation = projected.conversation.map(settle)
    const subagentRows = new Map<string, readonly NativeChatSubagentRow[]>()
    for (const [agentId, rows] of projected.subagentRows) {
      const settled = rows.map((row) => ({ ...row, message: settle(row.message) }))
      const prior = previous.subagentRows.get(agentId)
      subagentRows.set(
        agentId,
        prior && sameRows(prior, settled, sameSubagentRow) ? prior : settled
      )
    }
    const sameConversation = sameRows(previous.conversation, conversation, Object.is)
    const sameSubagents =
      subagentRows.size === previous.subagentRows.size &&
      Array.from(subagentRows).every(
        ([agentId, rows]) => previous.subagentRows.get(agentId) === rows
      )
    if (sameConversation && sameSubagents) {
      return previous
    }
    previous = {
      conversation: sameConversation ? previous.conversation : conversation,
      subagentRows: sameSubagents ? previous.subagentRows : subagentRows
    }
    byId = new Map(
      [
        ...conversation,
        ...Array.from(subagentRows.values())
          .flat()
          .map((row) => row.message)
      ].map((message) => [message.id, message])
    )
    return previous
  }
}
