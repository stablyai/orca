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

/** Whom an agent's Items filter offers, as its viewer sees them: the viewer first, then the owner (on
 *  a teammate's copy) and the teammates; null for an agent shared with no one. The owner's own copy
 *  reads its share list; a teammate's, the people its host named (`shareViewer`). */
export function botPeoplePicker(
  bot: Pick<Bot, 'shares' | 'shareViewer'>,
  ownerName: string | null
): BotPeopleEntry[] | null {
  const viewer = bot.shareViewer
  if (viewer) {
    const self = viewer.teammates.find((person) => person.accountId === viewer.accountId)
    return [
      {
        pick: { kind: 'person', person: self ?? { accountId: viewer.accountId, name: '' } },
        name: self?.name ?? null
      },
      { pick: { kind: 'owner' }, name: viewer.ownerName },
      ...viewer.teammates.flatMap((person) =>
        person.accountId === viewer.accountId
          ? []
          : [{ pick: { kind: 'person' as const, person }, name: person.name }]
      )
    ]
  }
  const people = botChatPeople(bot)
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

/** A pick's read. The pick the host's default already lists reads as `default`, the bot's one whole
 *  read with no second read of the same rows: everyone's on the owner's copy (and on an agent shared
 *  with no one), the viewer's own on a teammate's copy (`shareViewer`). */
export function botItemsWhoseOfPick(
  pick: BotChatPersonPick,
  bot: Pick<Bot, 'shares' | 'shareViewer'>
): BotItemsWhose {
  const viewer = bot.shareViewer
  const asDefault = viewer
    ? pick.kind === 'person' && pick.person.accountId === viewer.accountId
    : pick.kind === 'everyone'
  if (asDefault) {
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

/** Whose an item is, as an Everyone row names it before its age: anyone's but the viewer's own (null).
 *  `viewer`: a teammate's copy's `shareViewer`, whose owner's name the owner's rows show (else
 *  `ownerFallback`); absent, the owner looks. */
export function botItemPersonMark(
  item: Pick<BotItem, 'people'>,
  viewer: Bot['shareViewer'],
  ownerFallback: string
): string | null {
  if (!item.people) {
    return viewer ? (viewer.ownerName ?? ownerFallback) : null
  }
  const others = viewer
    ? item.people.filter((person) => person.accountId !== viewer.accountId)
    : item.people
  return others.map((person) => person.name).join(', ') || null
}
