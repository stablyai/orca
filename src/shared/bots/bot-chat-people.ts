// Whose chat or item each of a shared bot's is on the owner's lists, and the person filters of Chats and Items.
import type { Bot } from '../bot-types'
import type { BotItem } from './bot-items'
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

/** One person the pick offers, the viewer ("you") first; `name` null when the host doesn't know it. */
export type BotPeopleEntry = { pick: BotChatPersonPick; name: string | null }

/** Whom an agent's Items filter offers on the owner's copy: the owner first, then the teammates; null
 *  for an agent shared with no one and on a teammate's copy, which lists only the host's default for
 *  it (their own items, `botItemAccessOfCaller`). */
export function botPeoplePicker(
  bot: Pick<Bot, 'shares' | 'shareViewer'>,
  ownerName: string | null
): BotPeopleEntry[] | null {
  const people = bot.shareViewer ? [] : botChatPeople(bot)
  return people.length === 0
    ? null
    : [
        { pick: { kind: 'owner' }, name: ownerName },
        ...people.map((person) => ({
          pick: { kind: 'person' as const, person },
          name: person.name
        }))
      ]
}

export function sameBotPersonPick(a: BotChatPersonPick, b: BotChatPersonPick): boolean {
  return a.kind === 'person'
    ? b.kind === 'person' && a.person.accountId === b.person.accountId
    : a.kind === b.kind
}

/** Whom the Items tab shows: the viewer's own until another pick, and everyone's for an agent shared
 *  with no one. A pick whose person is gone falls back to the viewer's own. */
export function botItemsPersonPick(
  entries: readonly Pick<BotPeopleEntry, 'pick'>[] | null,
  picked: BotChatPersonPick | null
): BotChatPersonPick {
  if (!entries) {
    return { kind: 'everyone' }
  }
  if (picked?.kind === 'everyone') {
    return picked
  }
  const found = picked && entries.find((entry) => sameBotPersonPick(entry.pick, picked))
  return (found ?? entries[0]!).pick
}

/** Whose items a list read asks for: the caller's default (`default`), everyone's, the owner's own,
 *  or one teammate's. */
export type BotItemsWhose = 'default' | 'everyone' | 'owner' | `person:${string}`

/** A pick's read. A teammate's copy always reads its default (their own items); the owner's reads
 *  Everyone as its default, the bot's one whole read with no second read of the same rows. */
export function botItemsWhoseOfPick(
  pick: BotChatPersonPick,
  bot: Pick<Bot, 'shares' | 'shareViewer'>
): BotItemsWhose {
  if (bot.shareViewer || pick.kind === 'everyone') {
    return 'default'
  }
  return pick.kind === 'person' ? `person:${pick.person.accountId}` : pick.kind
}

/** The list read's params for whose items it asks. */
export function botItemsWhoseParams(whose: BotItemsWhose): {
  everyone?: true
  person?: string | null
} {
  if (whose === 'default') {
    return {}
  }
  if (whose === 'everyone') {
    return { everyone: true }
  }
  return { person: whose === 'owner' ? null : whose.slice('person:'.length) }
}

/** The pick's entry when it names someone other than the viewer, whose own is the default; null for
 *  everyone and for the viewer's own. */
export function botPickedOther<E extends { pick: BotChatPersonPick }>(
  pick: BotChatPersonPick,
  entries: readonly E[] | null
): E | null {
  const own = entries?.[0]
  if (!entries || !own || pick.kind === 'everyone' || sameBotPersonPick(pick, own.pick)) {
    return null
  }
  return entries.find((entry) => sameBotPersonPick(entry.pick, pick)) ?? null
}

/** Whose an item is, as the owner's Everyone row names it before its age: a teammate's, by name; null
 *  for the owner's own. */
export function botItemPersonMark(item: Pick<BotItem, 'people'>): string | null {
  return item.people?.map((person) => person.name).join(', ') || null
}
