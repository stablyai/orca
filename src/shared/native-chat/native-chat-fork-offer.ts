// "Fork from this response", decided the same way on desktop and phone.

import type { AgentSessionCapabilities } from '../agent-session/agent-session-capabilities'
import type { StructuredAgentSessionHostCapabilityState } from '../agent-session/structured-agent-session-host-capability'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessage } from './native-chat-types'

/** What a chat can fork: nothing, not yet known (drawn disabled), or through which turns. */
export type NativeChatForkSupport =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'known'; fork: NonNullable<AgentSessionCapabilities['fork']> }

/** `agent` is the host's registered row for the chat's agent: undefined until the host has listed it. */
export function nativeChatForkSupport(
  host: StructuredAgentSessionHostCapabilityState,
  agent: { capabilities: Pick<AgentSessionCapabilities, 'fork'> } | undefined
): NativeChatForkSupport {
  if (host === 'unsupported') {
    return { kind: 'none' }
  }
  if (host === 'unknown' || !agent) {
    return { kind: 'unknown' }
  }
  const fork = agent.capabilities.fork
  return fork === 'checkpoint' || fork === 'tip' ? { kind: 'known', fork } : { kind: 'none' }
}

/** A finished response of the chat's own agent, still in its current context. A fork copies through
 *  the end of that response's turn, so any of the turn's responses offers it, not only its last. */
export function nativeChatRowOffersFork(
  row: {
    message: NativeChatMessage
    /** Inside a subagent's section, whose replies are no root turn. */
    inSubagentSection: boolean
    turnWorking: boolean
    /** The row belongs to the conversation's newest turn. */
    inLatestTurn: boolean
  },
  chat: { support: NativeChatForkSupport; contextFloorSequence: number }
): boolean {
  const { message } = row
  const sequence = message.journalPosition?.sequence
  return (
    chat.support.kind !== 'none' &&
    message.role === 'assistant' &&
    message.source === 'transcript' &&
    !message.agentStart &&
    !row.inSubagentSection &&
    isRootAgentJournalItem(message) &&
    !row.turnWorking &&
    // Rows above a /clear are no longer in the agent's context.
    sequence !== undefined &&
    sequence > chat.contextFloorSequence &&
    (chat.support.kind === 'unknown' || chat.support.fork === 'checkpoint' || row.inLatestTurn)
  )
}
