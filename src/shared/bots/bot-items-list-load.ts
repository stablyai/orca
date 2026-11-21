// One read of an Items list (a bot's, or some chats'), building on the last: the whole list at the
// Closed depth its owner has loaded, the items a notice named merged in, and the next Closed page
// appended. Reads of one list run one at a time, so these never race over its value.
import { BOT_ITEM_LIMITS } from './bot-items'
import type { BotItemsListRead } from './bot-item-schema'
import {
  appendBotItemsClosedPage,
  botItemsClosedLoaded,
  mergeNamedBotItems
} from './bot-item-merge'
import { reuseEqualJson } from '../reuse-equal-json'

/** One `bots.items.owner.list` call with these params (the bot, its chats and `summary` added). */
export type BotItemsListCall = (params: Record<string, unknown>) => Promise<BotItemsListRead>

export type BotItemsListAsk = { whole: boolean; parts: readonly string[]; more: boolean }

export async function loadBotItemsList(
  call: BotItemsListCall,
  previous: BotItemsListRead | null,
  ask: BotItemsListAsk
): Promise<BotItemsListRead> {
  const page = BOT_ITEM_LIMITS.listPage
  if (ask.whole || !previous) {
    // The depth loaded so far, a page more when asked: in one read, or page by page from a host
    // before `closedLimit` (it answers one page).
    const loaded = previous ? botItemsClosedLoaded(previous) : 0
    const more = ask.more && previous?.nextClosedCursor ? page : 0
    const want = Math.max(page, loaded) + more
    let value = await call({ closedLimit: Math.min(want, BOT_ITEM_LIMITS.closedLoadMax) })
    while (value.nextClosedCursor && botItemsClosedLoaded(value) < want) {
      const rest = want - botItemsClosedLoaded(value)
      value = appendBotItemsClosedPage(
        value,
        await call({
          closedCursor: value.nextClosedCursor,
          closedOnly: true,
          closedLimit: Math.min(rest, BOT_ITEM_LIMITS.closedLoadMax)
        })
      )
    }
    return reuseEqualJson(previous, value)
  }
  let value = previous
  if (ask.parts.length > 0) {
    value = mergeNamedBotItems(value, await call({ uids: ask.parts }), ask.parts)
  }
  if (ask.more && value.nextClosedCursor) {
    value = appendBotItemsClosedPage(
      value,
      await call({ closedCursor: value.nextClosedCursor, closedOnly: true })
    )
  }
  return value
}
