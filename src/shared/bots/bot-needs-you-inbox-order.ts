// The cross-bot Needs you inbox's rows: every bot's Needs you items, the longest waiting first, or by
// bot in the sidebar's saved order and then the longest waiting first within each bot.
import { botItemActivityAt, type BotItem } from './bot-items'

export type BotNeedsYouInboxOrder = 'oldest' | 'bot'

export function botNeedsYouInboxRows(
  items: readonly BotItem[],
  order: BotNeedsYouInboxOrder,
  /** Bot ids in the order the sidebar saves them. */
  botOrder: readonly string[],
  now: number
): BotItem[] {
  const oldest = (a: BotItem, b: BotItem): number =>
    botItemActivityAt(a, now) - botItemActivityAt(b, now) || a.number - b.number
  if (order === 'oldest') {
    return items.toSorted(oldest)
  }
  const place = new Map(botOrder.map((id, index) => [id, index]))
  const placeOf = (item: BotItem): number => place.get(item.owner.botId) ?? botOrder.length
  return items.toSorted((a, b) => placeOf(a) - placeOf(b) || oldest(a, b))
}
