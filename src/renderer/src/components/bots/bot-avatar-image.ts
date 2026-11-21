// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

type Upload = {
  version: string
  src: Promise<string | null>
  /** The read's answer once it has one, so a picture drawn again (a row scrolled back) has it at once. */
  value?: string | null
  failedAt?: number
}

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A failed read is retried
// after a while, not by every row that mounts again meanwhile.
const uploads = new Map<string, Upload>()
const RETRY_FAILED_MS = 30_000

function uploadSrc(bot: BotRef, version: string): Promise<string | null> {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  if (
    cached?.version === version &&
    (cached.failedAt === undefined || Date.now() - cached.failedAt < RETRY_FAILED_MS)
  ) {
    return cached.src
  }
  const upload: Upload = { version, src: Promise.resolve(null) }
  upload.src = readBotAvatarPng(bot).then(
    (png) => {
      upload.value = png ? `data:image/png;base64,${png}` : null
      return upload.value
    },
    () => {
      upload.failedAt = Date.now()
      return null
    }
  )
  uploads.set(key, upload)
  return upload.src
}

/** The upload's picture when it has been read already; undefined until then. */
function readUploadSrc(bot: BotRef, version: string): string | null | undefined {
  const cached = uploads.get(botRefKey(bot))
  return cached?.version === version ? cached.value : undefined
}

/** The picture's URL; null shows the emoji or initial. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const [upload, setUpload] = useState<{ key: string; src: string | null } | null>(null)
  const { hostId, id } = bot
  const known = uploadKey ? readUploadSrc({ hostId, id }, uploadKey) : undefined
  useEffect(() => {
    if (!uploadKey || known !== undefined) {
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
  }, [hostId, id, uploadKey, known])
  if (mascotSrc) {
    return mascotSrc
  }
  if (known !== undefined) {
    return known
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
