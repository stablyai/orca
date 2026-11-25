// Whose chat each of a shared bot's chats is on the owner's list, and the Chats tab's person filter.
import type { Bot } from '../bot-types'
import type { BotChatPerson, BotChatTreeChat } from './bot-chat-tree'
import { botSharePersonName } from './bot-home-of'
import { botShareUsable } from './bot-team-shares'

/** The teammates who may have chats, as their share rows name them: the usable account shares,
 *  the same ones whose chats `botHomeOfActsFor` names. */
export function botChatPeople(bot: Pick<Bot, 'shares'>): BotChatPerson[] {
  return (bot.shares ?? []).flatMap((share) =>
    share.kind === 'account' && botShareUsable(share)
      ? [{ accountId: share.accountId, name: botSharePersonName(bot, share.accountId) }]
      : []
  )
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
