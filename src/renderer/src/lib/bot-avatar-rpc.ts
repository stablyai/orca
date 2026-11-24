import type { Bot } from '../../../shared/bot-types'
import { type BotRef, callBotRpc } from './bot-hosts'
import { stampBotHost } from './bot-catalog-snapshot'
import { refreshBotHost } from './bot-host-refresh'

/** A square 512 px PNG (base64) becomes the bot's picture, kept in its home. With `revision`, refused
 *  (bot_avatar_changed) if another picture, color or outfit write landed since; send it only to a host
 *  with bots.avatar-revision.v2. */
export async function uploadBotAvatar(ref: BotRef, png: string, revision?: number): Promise<Bot> {
  const { bot } = await callBotRpc<{ bot: Bot }>(ref, 'bots.avatar.upload', {
    botId: ref.id,
    png,
    expectedAvatarRevision: revision
  })
  await refreshBotHost(ref.hostId)
  return stampBotHost(ref.hostId, bot)
}

export async function readBotGenerationRevision(
  ref: BotRef,
  catalogRevision: number
): Promise<number> {
  const { revision } = await callBotRpc<{ revision: number }>(ref, 'bots.avatar.read', {
    botId: ref.id,
    catalogRevision
  })
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('bot_avatar_home_unreadable')
  }
  return revision
}

/** The uploaded picture as base64 PNG, or null when the bot has none. */
export async function readBotAvatarPng(bot: BotRef): Promise<string | null> {
  const { png } = await callBotRpc<{ png: string | null }>(bot, 'bots.avatar.read', {
    botId: bot.id
  })
  return png
}
