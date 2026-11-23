// How long a finished automation run's own chat stays open before it closes on its own.
import * as z from 'zod'

export const BotRunChatCloseAfterSchema = z.enum(['24h', '7d', 'never'])
export type BotRunChatCloseAfter = z.infer<typeof BotRunChatCloseAfterSchema>

/** Its choices in order, as Settings offers them. */
export const BOT_RUN_CHAT_CLOSE_CHOICES: readonly BotRunChatCloseAfter[] =
  BotRunChatCloseAfterSchema.options

export const DEFAULT_BOT_RUN_CHAT_CLOSE_AFTER: BotRunChatCloseAfter = '24h'

const HOUR_MS = 60 * 60 * 1000
const CLOSE_AFTER_MS: Record<BotRunChatCloseAfter, number | null> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  never: null
}

/** The bot's own choice, else its host's default; null for Never. */
export function botRunChatCloseAfterMs(
  bot: { runChatsCloseAfter?: BotRunChatCloseAfter },
  hostDefault: BotRunChatCloseAfter
): number | null {
  return CLOSE_AFTER_MS[bot.runChatsCloseAfter ?? hostDefault]
}
