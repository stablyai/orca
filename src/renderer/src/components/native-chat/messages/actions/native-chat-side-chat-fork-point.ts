import { nativeChatRowOffersFork } from '../../../../../../shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessageSlot } from '../../conversation/slots/native-chat-transcript-slots'

/** Where a side chat forks: the newest response "Fork from this response" offers, or why none is. */
export type NativeChatSideChatForkPoint =
  | { kind: 'ready'; throughItemId: string }
  | { kind: 'reply-running' }
  | { kind: 'no-reply' }

/** What the transcript needs to find that response while it lays out its rows. */
export type NativeChatSideChatForkOffer = {
  chat: Parameters<typeof nativeChatRowOffersFork>[1]
  latestTurnKey: string | undefined
}

/** The rule each response row's Fork uses. */
export function nativeChatSlotOffersFork(
  slot: NativeChatMessageSlot,
  offer: NativeChatSideChatForkOffer
): boolean {
  return nativeChatRowOffersFork(
    {
      message: slot.message,
      inSubagentSection: false,
      turnWorking: slot.activeTurnIsWorking,
      inLatestTurn: slot.turnKey !== undefined && slot.turnKey === offer.latestTurnKey
    },
    offer.chat
  )
}

export function nativeChatSideChatForkPoint(
  newestOffered: NativeChatMessageSlot | undefined,
  working: boolean
): NativeChatSideChatForkPoint {
  if (newestOffered) {
    return { kind: 'ready', throughItemId: newestOffered.message.id }
  }
  return working ? { kind: 'reply-running' } : { kind: 'no-reply' }
}
