// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

type Upload = {
  version: string
  /** The finished read: a data URL, or null for none. */
  read?: string | null
  /** Faces waiting on the read in flight; each leaves as it unmounts. */
  waiting: Set<(src: string | null) => void>
}

// Each bot's current upload only (by botRefKey), so a replaced picture is let go; a failed read is retried
// next time. A finished read is kept, so a face drawn again (a row scrolled back into view) shows it at once.
const uploads = new Map<string, Upload>()

function readUpload(
  bot: BotRef,
  version: string,
  onRead: (src: string | null) => void
): () => void {
  const key = botRefKey(bot)
  let entry = uploads.get(key)
  if (entry?.version !== version) {
    const started: Upload = { version, waiting: new Set() }
    entry = started
    uploads.set(key, started)
    void readBotAvatarPng(bot).then(
      (png) => {
        started.read = png ? `data:image/png;base64,${png}` : null
        settle(started, started.read)
      },
      () => {
        if (uploads.get(key) === started) {
          uploads.delete(key)
        }
        settle(started, null)
      }
    )
  }
  const current = entry
  if (current.read !== undefined) {
    const read = current.read
    let live = true
    queueMicrotask(() => {
      if (live) {
        onRead(read)
      }
    })
    return () => {
      live = false
    }
  }
  current.waiting.add(onRead)
  return () => {
    current.waiting.delete(onRead)
  }
}

function settle(entry: Upload, src: string | null): void {
  const waiting = [...entry.waiting]
  entry.waiting.clear()
  waiting.forEach((onRead) => onRead(src))
}

function finishedUpload(
  bot: BotRef,
  version: string | null
): { key: string; src: string | null } | null {
  const cached = version ? uploads.get(botRefKey(bot)) : undefined
  return version && cached?.version === version && cached.read !== undefined
    ? { key: version, src: cached.read }
    : null
}

/** The picture's URL; null shows the emoji or initial. `paused`: don't read now (its host is offline);
 *  the read starts when it isn't. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  paused = false
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const [upload, setUpload] = useState(() => finishedUpload({ hostId, id }, uploadKey))
  useEffect(() => {
    if (!uploadKey || paused) {
      return
    }
    return readUpload({ hostId, id }, uploadKey, (src) =>
      setUpload((shown) =>
        shown?.key === uploadKey && shown.src === src ? shown : { key: uploadKey, src }
      )
    )
  }, [hostId, id, uploadKey, paused])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
