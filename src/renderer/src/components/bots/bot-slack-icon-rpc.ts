// The bot host's two Slack icon calls, behind its bots.slack-icon capability.
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'

/** Whether the host wants `look` drawn, and whether `look` is the bot's look there yet. */
export function botSlackIconWanted(
  bot: BotRef,
  look: string
): Promise<{ wanted: boolean; current: boolean }> {
  return callBotRpc(bot, 'bots.avatar.slackIcon.wanted', { botId: bot.id, look })
}

/** False when the host's look changed since and it dropped the drawing. */
export async function uploadBotSlackIcon(bot: BotRef, look: string, png: string): Promise<boolean> {
  const { stored } = await callBotRpc<{ stored: boolean }>(bot, 'bots.avatar.slackIcon.upload', {
    botId: bot.id,
    look,
    png
  })
  return stored
}

/** Try again for an icon the host already keeps: it is sent to the cloud again. False when none is kept. */
export async function resendBotSlackIcon(bot: BotRef): Promise<boolean> {
  const { resent } = await callBotRpc<{ resent: boolean }>(bot, 'bots.avatar.slackIcon.resend', {
    botId: bot.id
  })
  return resent
}
