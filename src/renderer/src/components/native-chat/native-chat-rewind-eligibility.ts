import type { AgentSessionRewindSupport } from '../../../../shared/agent-session-rewind'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Keep in-doubt rewind support available; the live status latch resolves it, not this cached read. */
export function nativeChatRewindOffered(support: AgentSessionRewindSupport | undefined): boolean {
  return support !== undefined && (support.supported || support.reason === 'outcome-unknown')
}

/** Offer only own top-level turn openers with recoverable images; rewinding steers would discard their opener too. */
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
