import { botTarget, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { botConnectorRowKey, forgetBotConnectorPage } from '../bot-connector-page'
import { refreshGoogle } from './google-connect-client'

/** With `on`: only `accounts` (absent is every account), and the askers the owner was shown. */
type GoogleBotSet = { accounts?: readonly string[]; confirmedAskers?: readonly string[] }

/** The bot toggle lives with the bot, on its host. */
export async function setBotGoogle(
  bot: BotRef,
  on: boolean,
  set: GoogleBotSet = {}
): Promise<void> {
  await callBotRpc(bot, 'google.bot.set', { botId: bot.id, on, ...(on ? set : {}) })
  if (!on) {
    forgetBotConnectorPage(botConnectorRowKey(bot, 'google'))
  }
  await refreshGoogle(botTarget(bot))
}
