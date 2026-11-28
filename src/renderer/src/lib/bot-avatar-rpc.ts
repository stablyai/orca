import type { BotPictureRevision } from '../../../shared/bot-avatar'
import type { Bot } from '../../../shared/bot-types'
import { type BotRef, callBotRpc } from './bot-hosts'
import { stampBotHost } from './bot-catalog-snapshot'
import { refreshBotHost } from './bot-host-refresh'

/** A square 512 px PNG (base64) becomes the bot's picture, kept in its home. With `revision`, refused
 *  (bot_avatar_changed) if another picture, color or outfit write landed since; send it only to a host
 *  with bots.avatar-revision.v3. */
export async function uploadBotAvatar(
  ref: BotRef,
  png: string,
  expected?: BotPictureRevision
): Promise<Bot> {
  try {
    const { bot } = await callBotRpc<{ bot: Bot }>(ref, 'bots.avatar.upload', {
      botId: ref.id,
      png,
      expectedAvatarRevision: expected?.revision,
      expectedAvatarEpoch: expected?.epoch
    })
    return stampBotHost(ref.hostId, bot)
  } finally {
    // A lost response can follow a committed write. The next Generate needs the host's revision.
    await refreshBotHost(ref.hostId)
  }
}

export async function readBotGenerationRevision(
  ref: BotRef,
  catalogRevision: number,
  catalogEpoch?: string
): Promise<BotPictureRevision> {
  const token = await callBotRpc<BotPictureRevision>(ref, 'bots.avatar.read', {
    botId: ref.id,
    catalogRevision,
    catalogEpoch
  })
  if (!Number.isSafeInteger(token.revision) || token.revision < 0) {
    throw new Error('bot_avatar_home_unreadable')
  }
  return token
}

/** The uploaded picture as base64 PNG, or null when the bot has none. */
export async function readBotAvatarPng(bot: BotRef): Promise<string | null> {
  const { png } = await callBotRpc<{ png: string | null }>(bot, 'bots.avatar.read', {
    botId: bot.id
  })
  return png
}
