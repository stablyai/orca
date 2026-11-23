// Webhooks in a bot's connector lists. There's no account to link, so the first hook is the connector,
// and it shows only once the bot's host says webhooks are on.
import { botTarget, type BotRef } from '@/lib/bot-hosts'
import { translate } from '@/i18n/i18n'
import { useBotWebhooks } from './use-webhook-data'

/** Null until the host answers, and while the cloud or this Orca has no webhooks: nothing to offer then. */
export function useWebhooksConnector(bot: BotRef): 'added' | 'available' | null {
  const read = useBotWebhooks(botTarget(bot), bot.id)
  if (read.status !== 'ready') {
    return null
  }
  return read.value.length > 0 ? 'added' : 'available'
}

/** The bot's Chat with "Set up a webhook that " typed: hooks are made there. */
export function webhookSetUpDraft(): string {
  return translate('bots.webhooks.setUpDraft', 'Set up a webhook that ')
}
