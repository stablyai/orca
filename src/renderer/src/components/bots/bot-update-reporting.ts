import { toast } from 'sonner'
import { updateBot } from '@/lib/bot-catalog'
import type { BotRef } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import { botErrorMessage } from './bot-presentation'

/** Saves a bot change; a refusal is reported in a toast and resolves to null. */
export function updateBotReporting(
  bot: BotRef,
  updates: Parameters<typeof updateBot>[1]
): Promise<Bot | null> {
  return updateBot(bot, updates).catch((error: unknown) => {
    toast.error(botErrorMessage(error))
    return null
  })
}
