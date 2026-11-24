// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useMemo, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { wornBotOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { useBotMascotLayers, type BotOutfitArt, type BotPictureSize } from './bot-mascot-look'
import { botShapePicture } from './bot-shape-picture'

// Each bot's current upload only (by botRefKey), so a replaced picture is let go; a failed read is retried next time.
// `read`: the finished read, for a caller that may not ask the host now.
const uploads = new Map<
  string,
  { version: string; src: Promise<string | null>; read?: string | null }
>()

function uploadSrc(bot: BotRef, version: string): Promise<string | null> {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  if (cached?.version === version) {
    return cached.src
  }
  const entry: { version: string; src: Promise<string | null>; read?: string | null } = {
    version,
    src: readBotAvatarPng(bot).then(
      (png) => (entry.read = png ? `data:image/png;base64,${png}` : null),
      () => {
        uploads.delete(key)
        return null
      }
    )
  }
  uploads.set(key, entry)
  return entry.src
}

/** The shared cache's finished read of that version, if any: a data URL or null; undefined when none. */
export function peekBotUploadSrc(bot: BotRef, version: string): string | null | undefined {
  const cached = uploads.get(botRefKey(bot))
  return cached?.version === version ? cached.read : undefined
}

/** The bot's uploaded picture through the shared cache: a data URL, null for none, undefined when the
 *  read failed. */
export function readBotUploadSrc(bot: BotRef, version: string): Promise<string | null | undefined> {
  return uploadSrc(bot, version).then((src) =>
    src === null && uploads.get(botRefKey(bot))?.version !== version ? undefined : src
  )
}

type AvatarBot = Pick<Bot, 'id' | 'avatar' | 'avatarColor' | 'avatarOutfit'> & BotOnHost

/** The picture with its outfit's art as a second image over it, for a tile that can stack the two. */
export function useBotAvatarLook(
  bot: AvatarBot,
  size: BotPictureSize = 'small'
): { src: string | null; outfit: BotOutfitArt | null } {
  const parsed = parseBotAvatar(bot.avatar)
  const mascot = useBotMascotLayers(
    parsed?.kind === 'mascot' ? parsed.id : null,
    bot.avatarColor,
    wornBotOutfit(bot.avatarOutfit),
    size
  )
  const upload = useUploadSrc(bot)
  const isShape = parsed?.kind === 'shape'
  const color = bot.avatarColor
  const shape = useMemo(() => (isShape ? botShapePicture(color) : null), [isShape, color])
  return mascot ?? { src: shape ?? upload, outfit: null }
}

function useUploadSrc(bot: AvatarBot): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const [upload, setUpload] = useState<{ key: string; src: string | null } | null>(null)
  const { hostId, id } = bot
  useEffect(() => {
    if (!uploadKey) {
      return
    }
    let live = true
    void uploadSrc({ hostId, id }, uploadKey).then((src) => {
      if (live) {
        setUpload({ key: uploadKey, src })
      }
    })
    return () => {
      live = false
    }
  }, [hostId, id, uploadKey])
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
