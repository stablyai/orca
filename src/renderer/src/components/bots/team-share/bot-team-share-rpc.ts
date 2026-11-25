// The owner's share-list calls, on the host that runs the bot; each answers the bot as changed.
import { publishBots, readHostBots } from '@/lib/bot-catalog-snapshot'
import { beginBotHostUpdate } from '@/lib/bot-host-refresh'
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'

/** Shown on the host's answer, then the host is re-read. */
async function changeShares<TResult extends { bot: Bot }>(
  target: BotRef,
  method: string,
  params: unknown
): Promise<TResult> {
  const { hostId } = target
  const endUpdate = beginBotHostUpdate(hostId)
  try {
    const answer = await callBotRpc<TResult>(target, method, params)
    publishBots(
      readHostBots(hostId).map((entry) => (entry.id === target.id ? answer.bot : entry)),
      undefined,
      hostId
    )
    return answer
  } finally {
    await endUpdate()
  }
}

export function addBotTeamShare(bot: BotRef, email: string): Promise<{ bot: Bot }> {
  return changeShares(bot, 'bots.teamShares.add', { botId: bot.id, emails: [email] })
}

export function removeBotTeamShare(bot: BotRef, shareId: string): Promise<{ bot: Bot }> {
  return changeShares(bot, 'bots.teamShares.remove', { botId: bot.id, shareId })
}

/** emailed: false while the email still waits (its hourly limit, or an Orca Cloud without invites). */
export function resendBotTeamShare(
  bot: BotRef,
  shareId: string
): Promise<{ bot: Bot; emailed: boolean }> {
  return changeShares(bot, 'bots.teamShares.resend', { botId: bot.id, shareId })
}
