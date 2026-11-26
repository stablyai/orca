import { botTarget } from '@/lib/bot-hosts'
import { automationHookId } from '../../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../../shared/bot-types'
import { copyWebhookUrl } from './use-webhook-key'

/** Copy URL for an automation a webhook starts, read from its bot's host; null for any other
 *  automation, or when its bot isn't listed here. */
export function automationWebhookUrlCopy(
  automation: Parameters<typeof automationHookId>[0] & { bot?: { botId: string } },
  bots: readonly Bot[]
): (() => void) | null {
  const hookId = automationHookId(automation)
  const bot = hookId ? bots.find((entry) => entry.id === automation.bot?.botId) : undefined
  if (!hookId || !bot) {
    return null
  }
  return () => void copyWebhookUrl({ target: botTarget(bot), hookId, botName: bot.name })
}
