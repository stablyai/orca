// Days an untouched ask waits before it moves to Stale; kept beside the bot's schema, which reads it.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/** Its choices in order, as Settings offers them. */
export const BOT_ITEMS_STALE_CHOICES = [3, 5, 7, 14, 'never'] as const
export type BotItemsStale = (typeof BOT_ITEMS_STALE_CHOICES)[number]

export const BotItemsStaleSchema = lazyZodSchema(() =>
  z.union(BOT_ITEMS_STALE_CHOICES.map((choice) => z.literal(choice)))
)
