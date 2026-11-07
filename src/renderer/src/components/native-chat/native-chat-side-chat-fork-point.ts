import { nativeChatRowOffersFork } from '../../../../shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'

/** Where a side chat forks: the newest response "Fork from this response" offers, or why none is. */
export type NativeChatSideChatForkPoint =
  | { kind: 'ready'; throughItemId: string }
  | { kind: 'reply-running' }
  | { kind: 'no-reply' }

/** Read off the drawn transcript's root responses, newest turn first, with the rule each response
 *  row's Fork uses. A running turn, whose rows offer none, is stepped over whole. */
export function nativeChatSideChatForkPoint(
  responseGroups: readonly (readonly NativeChatMessageSlot[])[],
  latestTurnKey: string | undefined,
  working: boolean,
  chat: Parameters<typeof nativeChatRowOffersFork>[1]
): NativeChatSideChatForkPoint {
  const tipOnly = chat.support.kind === 'known' && chat.support.fork === 'tip'
  for (let turn = responseGroups.length - 1; turn >= 0; turn--) {
    const group = responseGroups[turn]
    const newest = group.at(-1)
    if (!newest || newest.activeTurnIsWorking) {
      continue
    }
    const sequence = newest.message.journalPosition?.sequence
    // Older turns are above a /clear or, at a tip-only agent, not the newest turn: none can fork.
    if (
      (sequence !== undefined && sequence <= chat.contextFloorSequence) ||
      (tipOnly && newest.turnKey !== latestTurnKey)
    ) {
      break
    }
    for (let index = group.length - 1; index >= 0; index--) {
      const slot = group[index]
      if (
        nativeChatRowOffersFork(
          {
            message: slot.message,
            inSubagentSection: false,
            turnWorking: slot.activeTurnIsWorking,
            inLatestTurn: slot.turnKey !== undefined && slot.turnKey === latestTurnKey
          },
          chat
        )
      ) {
        return { kind: 'ready', throughItemId: slot.message.id }
      }
    }
  }
  return working ? { kind: 'reply-running' } : { kind: 'no-reply' }
}
