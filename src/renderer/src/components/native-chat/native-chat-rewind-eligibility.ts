// Where "Rewind to here" is offered: which providers can rewind, and which transcript rows.

import type { AgentSessionRewindSupport } from '../../../../shared/agent-session-rewind'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Whether the provider can rewind at all. An in-doubt read is still capable: the status feed's
 *  live latch, not this cached read, says when it resolves. */
export function nativeChatRewindOffered(support: AgentSessionRewindSupport | undefined): boolean {
  return support !== undefined && (support.supported || support.reason === 'outcome-unknown')
}

/** A sent prompt that opened its own turn, outside any subagent's section. Codex rewinds whole
 *  turns, so a steer would also discard its turn's opener; unsent, queued, command and goal rows
 *  have no turn to go back to. An image with no local file could not go back to the composer, and
 *  another agent's message is not the person's to take back into their composer. */
export function nativeChatRowOffersRewind(
  message: NativeChatMessage,
  slot: { depth: number; turnKey: string | undefined },
  hasDeliveryNotice: boolean
): boolean {
  return (
    message.role === 'user' &&
    slot.depth === 0 &&
    slot.turnKey === message.id &&
    !hasDeliveryNotice &&
    message.queued !== true &&
    message.command === undefined &&
    message.sentAs === undefined &&
    message.from === undefined &&
    message.blocks.every((block) => block.type !== 'image-ref' || Boolean(block.path))
  )
}
