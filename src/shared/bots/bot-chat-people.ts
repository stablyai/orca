// Whose chat each of a shared bot's chats is on the owner's list, and the Chats tab's person filter.
import { shareOwnsChat, type BotRequestAsker } from './bot-acts-for'
import type { BotChatPerson, BotChatTreeChat } from './bot-chat-tree'
import type { BotShare } from './bot-team-shares'

/** The teammates a bot is shared with by account, as their share rows name them. */
export function botChatPeople(shares: readonly BotShare[] | undefined): BotChatPerson[] {
  return (shares ?? []).flatMap((share) =>
    share.kind === 'account'
      ? [{ accountId: share.accountId, name: share.name ?? share.email }]
      : []
  )
}

/** The teammate a chat acts for alone, by Orca's record; none for the owner's or an unrecorded chat. */
export function botChatPersonOf(
  actsFor: readonly BotRequestAsker[] | undefined,
  people: readonly BotChatPerson[]
): BotChatPerson | undefined {
  return actsFor ? people.find((person) => shareOwnsChat(actsFor, person.accountId)) : undefined
}

/** Who the Chats tab shows: everyone, the owner's own chats, or one teammate's. */
export type BotChatPersonPick =
  | { kind: 'everyone' }
  | { kind: 'owner' }
  | { kind: 'person'; person: BotChatPerson }

export function botChatPickHas(pick: BotChatPersonPick, chat: BotChatTreeChat): boolean {
  switch (pick.kind) {
    case 'everyone':
      return true
    case 'owner':
      return chat.person === undefined
    case 'person':
      return chat.person?.accountId === pick.person.accountId
  }
}
