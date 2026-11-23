// Who a list's rows belong to: one bot, or a group's members, each row acting on its own bot.
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import type { BotNeedView } from '../use-bot-now'

/** A group's members' items in one list: each row acts on its own bot and shows its face. */
export type BotItemsListMembers = {
  /** Where the list keeps its folds. */
  foldKey: string
  botOf: (item: BotItem) => Bot
  /** Each bot's seen mark, for its rows' dots. */
  seenOf: (item: BotItem) => string
  /** Each ask's bot. */
  needBot: (need: BotNeedView) => Bot
  /** The chat a row names on its second line, for a row outside the chats the list is about. */
  placeOf: (item: BotItem) => string | null
  /** Which rows have that second line, without naming it; null when no row can. */
  placed?: ((item: BotItem) => boolean) | null
  /** Needs you's rows the shown bots have outside the list's chats, "N more outside this group", and
   *  what those chats are. */
  outside: { count: number; of: 'group' | 'room' | 'thread' }
}

export type ListOwner = Omit<BotItemsListMembers, 'needBot'> & {
  needBot: Bot | BotItemsListMembers['needBot']
  /** Rows show their bot's face: the list is a group's. */
  faces: boolean
}

export function listOwner(bot: Bot | BotItemsListMembers, seenEventId: string): ListOwner {
  if ('botOf' in bot) {
    return { ...bot, faces: true }
  }
  return {
    foldKey: bot.id,
    botOf: () => bot,
    seenOf: () => seenEventId,
    needBot: bot,
    placeOf: () => null,
    outside: { count: 0, of: 'group' },
    faces: false
  }
}
