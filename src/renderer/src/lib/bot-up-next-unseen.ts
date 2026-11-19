// Each bot's new Up next count, for its sidebar count and Activity tab; a look's suggestions and the owner's
// seeing them both send botsChanged, which reads it again.
import { useBotPanelFolded } from '@/components/bots/use-bot-panel-fold'
import { createBotHostUnseenCounts } from './bot-host-per-bot-read'
import { callBotRpc, type BotRef } from './bot-hosts'

const upNextCounts = createBotHostUnseenCounts('bots.upNext.unseen', ['lookAround', 'bot'])

/**
 * The bot's new Up next suggestions; 0 when none, from a host that doesn't count them, or while the owner
 * keeps its Suggestions folded: they stay unseen until opened, without a count that never clears.
 */
export function useBotUpNextUnseen(bot: BotRef | null): number {
  const count = upNextCounts.useCount(bot)
  return useBotPanelFolded(bot?.id ?? null, 'suggestions') ? 0 : count
}

/** The owner saw the bot's Up next; its host stops counting what it lists as new. */
export async function markBotUpNextSeen(bot: BotRef): Promise<void> {
  try {
    await callBotRpc(bot, 'bots.upNext.seen', { botId: bot.id })
  } catch {}
  void upNextCounts.read(bot.hostId)
}
