import { readAgentJournalTurn } from '../../../../shared/agent-session-turn-record'
import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../../../../shared/agent-session-context-clear'
import {
  savedRewindKeys,
  isAgentSessionRewindTarget
} from '../../../../shared/agent-session-rewind'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'

type RewindEligibilityInput = {
  state: StructuredAgentSessionState
  contextFloor?: AgentJournalCursor
}
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

export function isRewindTarget(input: RewindEligibilityInput, itemId: string): boolean {
  const opener = turnOpeners(input.state.items)
  const keys = savedRewindKeys(input.state.submissions)
  return input.state.items.some(
    (item) =>
      item.itemId === itemId &&
      item.sequence > rewindContextFloor(input) &&
      (keys.nativeIdentity(itemId) !== null || !keys.hasSubmission(itemId)) &&
      isAgentSessionRewindTarget(item, (turn) => opener.get(turn))
  )
}

export function turnOpeners(items: StructuredAgentSessionState['items']): Map<string, string> {
  const openers = new Map<string, string>()
  for (const item of items) {
    const opener = readAgentJournalTurn(item.body)?.userItemId
    if (opener) {
      openers.set(item.itemId, opener)
    }
  }
  return openers
}

export function rewindContextFloor(input: RewindEligibilityInput): number {
  return Math.max(
    latestAgentSessionContextClearSequence(input.state.items),
    agentSessionContextFloorSequence(input.contextFloor, input.state.epoch)
  )
}
