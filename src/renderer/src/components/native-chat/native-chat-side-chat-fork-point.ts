import { nativeChatRowOffersFork } from '../../../../shared/native-chat/native-chat-fork-offer'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Where a side chat forks: the newest response "Fork from this response" offers, or why none is. */
export type NativeChatSideChatForkPoint =
  | { kind: 'ready'; throughItemId: string }
  | { kind: 'reply-running' }
  | { kind: 'no-reply' }

/** Read off the drawn transcript, newest first, with the rule each response row's Fork uses. */
export function nativeChatSideChatForkPoint(
  slots: readonly NativeChatTranscriptSlot[],
  latestTurnKey: string | undefined,
  working: boolean,
  chat: Parameters<typeof nativeChatRowOffersFork>[1]
): NativeChatSideChatForkPoint {
  const tipOnly = chat.support.kind === 'known' && chat.support.fork === 'tip'
  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index]
    if (slot.kind !== 'message') {
      continue
    }
    const sequence = slot.message.journalPosition?.sequence
    // Older rows are above a /clear or, at a tip-only agent, outside the newest turn: none can fork.
    if (
      (sequence !== undefined && sequence <= chat.contextFloorSequence) ||
      (tipOnly && slot.turnKey !== undefined && slot.turnKey !== latestTurnKey)
    ) {
      break
    }
    if (
      nativeChatRowOffersFork(
        {
          message: slot.message,
          inSubagentSection: slot.depth > 0,
          turnWorking: slot.activeTurnIsWorking,
          inLatestTurn: slot.turnKey !== undefined && slot.turnKey === latestTurnKey
        },
        chat
      )
    ) {
      return { kind: 'ready', throughItemId: slot.message.id }
    }
  }
  return working ? { kind: 'reply-running' } : { kind: 'no-reply' }
}
