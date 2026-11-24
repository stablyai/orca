// Days an untouched ask waits before it moves to Stale; kept beside the bot's schema, which reads it.
import * as z from 'zod'

export const BotItemsStaleSchema = z.union([
  z.literal(3),
  z.literal(5),
  z.literal(7),
  z.literal(14),
  z.literal('never')
])
export type BotItemsStale = z.infer<typeof BotItemsStaleSchema>
/** Its choices in order, as Settings offers them. */
export const BOT_ITEMS_STALE_CHOICES: readonly BotItemsStale[] = BotItemsStaleSchema.options.map(
  (option) => option.value
)
