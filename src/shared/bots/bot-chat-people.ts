// Whose chat or item each of a shared bot's is on the owner's lists, and the person filters of Chats and Items.
import type { Bot } from '../bot-types'
import type { BotChatPerson, BotChatTreeChat } from './bot-chat-tree'
import { botSharePersonName } from './bot-home-of'
import { botShareUsable } from './bot-team-shares'

/** A teammate as the owner's lists name them: the one name lookup for whose chat or item it is. */
export function botChatPerson(bot: Pick<Bot, 'shares'>, accountId: string): BotChatPerson {
  return { accountId, name: botSharePersonName(bot, accountId) }
}

/** The teammates who may have chats and items, as their share rows name them: the usable account
 *  shares, the same ones whose chats `botHomeOfActsFor` names. */
export function botChatPeople(bot: Pick<Bot, 'shares'>): BotChatPerson[] {
  return (bot.shares ?? []).flatMap((share) =>
    share.kind === 'account' && botShareUsable(share) ? [botChatPerson(bot, share.accountId)] : []
  )
}

/** Who the Chats or Items tab shows: everyone, the owner's own, or one teammate's. */
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

/** Whom a shared bot's Items tab shows: the owner's own until another pick, and everyone's for a bot
 *  shared with no one. A teammate whose share went away falls back to the owner's own. */
export function botItemsPersonPick(
  people: readonly BotChatPerson[],
  picked: BotChatPersonPick | null
): BotChatPersonPick {
  if (people.length === 0) {
    return { kind: 'everyone' }
  }
  if (picked?.kind === 'person') {
    const person = people.find((entry) => entry.accountId === picked.person.accountId)
    return person ? { kind: 'person', person } : { kind: 'owner' }
  }
  return picked ?? { kind: 'owner' }
}

/** The list read's person for a pick: a teammate's account, null for the owner's own, undefined for
 *  everyone's. */
export function botPickAccount(pick: BotChatPersonPick): string | null | undefined {
  return pick.kind === 'person' ? pick.person.accountId : pick.kind === 'owner' ? null : undefined
}
