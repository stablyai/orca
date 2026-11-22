import { callBotRpc } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import { openBotSession } from './bot-session-open'

/** A chat Orca closed opens again in place: the host keeps it open for its items first, so nothing
 *  closes it again before new work, then its tab shows. */
export function reopenBotChat(bot: Bot, chatId: string): void {
  void callBotRpc(
    bot,
    'bots.chat.reopen',
    { sessionId: chatId },
    { suppressFeatureInteraction: true }
  )
    .catch((error: unknown) => console.warn('[bots] could not reopen a chat', error))
    .finally(() => openBotSession(bot, chatId))
}
