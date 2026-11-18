// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { BOT_MASCOT_URLS } from './bot-mascots'

// Each bot's current upload only (by botRefKey), so a replaced picture is let go; a failed read is retried next time.
const uploads = new Map<string, { version: string; src: Promise<string | null> }>()

function uploadSrc(bot: BotRef, version: string): Promise<string | null> {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  if (cached?.version === version) {
    return cached.src
  }
  const src = readBotAvatarPng(bot).then(
    (png) => (png ? `data:image/png;base64,${png}` : null),
    () => {
      uploads.delete(key)
      return null
    }
  )
  uploads.set(key, { version, src })
  return src
}

/** The picture's URL; null shows the emoji or initial. */
export function useBotAvatarSrc(bot: Pick<Bot, 'id' | 'avatar'> & BotOnHost): string | null {
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
  if (parsed?.kind === 'mascot') {
    return BOT_MASCOT_URLS[parsed.id]
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
