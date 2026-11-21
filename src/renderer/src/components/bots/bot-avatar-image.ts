// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

// Each bot's current upload only (by botRefKey), so a replaced picture is let go; a failed read is retried next time.
// `read`: the finished read, so a face drawn again (a row scrolled back into view) shows it at once.
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
      (png) => {
        entry.read = png ? `data:image/png;base64,${png}` : null
        return entry.read
      },
      () => {
        if (uploads.get(key) === entry) {
          uploads.delete(key)
        }
        return null
      }
    )
  }
  uploads.set(key, entry)
  return entry.src
}

function readUpload(bot: BotRef, version: string | null): string | null | undefined {
  const cached = version ? uploads.get(botRefKey(bot)) : undefined
  return cached?.version === version ? cached.read : undefined
}

/** The picture's URL; null shows the emoji or initial. `skipOffline`: no read while the bot's host is
 *  known offline (rows that mount as a list scrolls would each read again). */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  skipOffline = false
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const [upload, setUpload] = useState<{ key: string; src: string | null } | null>(() => {
    const read = readUpload({ hostId, id }, uploadKey)
    return uploadKey && read !== undefined ? { key: uploadKey, src: read } : null
  })
  const done = uploadKey !== null && upload?.key === uploadKey
  useEffect(() => {
    if (!uploadKey || done || (skipOffline && readBotHostState(hostId) === 'offline')) {
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
  }, [hostId, id, uploadKey, done, skipOffline])
  if (mascotSrc) {
    return mascotSrc
  }
  return done && upload ? upload.src : null
}
