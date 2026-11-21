// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

type Upload = { version: string; src: Promise<string | null>; read?: string | null }

// Each bot's current upload only (by botRefKey), so a replaced picture is let go; a failed read is retried next time.
// `read`: the finished read, so a face drawn again (a row scrolled back into view) shows it at once.
const uploads = new Map<string, Upload>()

// Each bot's last failed read (by botRefKey), which row faces mounting as a list scrolls don't send again
// for RETRY_MS. One per bot, dropped as a read succeeds.
const failures = new Map<string, { version: string; at: number }>()
const RETRY_MS = 10_000

function uploadSrc(bot: BotRef, version: string): Promise<string | null> {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  if (cached?.version === version) {
    return cached.src
  }
  const upload: Upload = {
    version,
    src: readBotAvatarPng(bot).then(
      (png) => {
        failures.delete(key)
        upload.read = png ? `data:image/png;base64,${png}` : null
        return upload.read
      },
      () => {
        failures.set(key, { version, at: Date.now() })
        if (uploads.get(key) === upload) {
          uploads.delete(key)
        }
        return null
      }
    )
  }
  uploads.set(key, upload)
  return upload.src
}

function readUpload(bot: BotRef, version: string | null): string | null | undefined {
  const cached = version ? uploads.get(botRefKey(bot)) : undefined
  return cached?.version === version ? cached.read : undefined
}

function failedLately(bot: BotRef, version: string): boolean {
  const failure = failures.get(botRefKey(bot))
  return failure?.version === version && Date.now() - failure.at < RETRY_MS
}

/** The picture's URL; null shows the emoji or initial. `backoff`: a version whose read just failed isn't
 *  read again for a while (rows that mount as a list scrolls would each read it). */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  backoff = false
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const [upload, setUpload] = useState<{ key: string; src: string | null } | null>(() => {
    const read = readUpload({ hostId, id }, uploadKey)
    return uploadKey && read !== undefined ? { key: uploadKey, src: read } : null
  })
  useEffect(() => {
    if (!uploadKey) {
      return
    }
    const show = (src: string | null): void =>
      setUpload((prev) =>
        prev?.key === uploadKey && prev.src === src ? prev : { key: uploadKey, src }
      )
    const read = readUpload({ hostId, id }, uploadKey)
    if (read !== undefined) {
      show(read)
      return
    }
    if (backoff && failedLately({ hostId, id }, uploadKey)) {
      return
    }
    let live = true
    void uploadSrc({ hostId, id }, uploadKey).then((src) => {
      if (live) {
        show(src)
      }
    })
    return () => {
      live = false
    }
  }, [hostId, id, uploadKey, backoff])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
