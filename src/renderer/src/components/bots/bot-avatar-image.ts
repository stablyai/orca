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
  failedAt?: number
  /** Faces waiting on the read in flight; each leaves as it unmounts, so scrolling adds none. */
  waiting: Set<(src: string | null) => void>
}

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A finished read is
// kept, so a face drawn again (a row scrolled back into view) shows it at once; a failed read is retried
// once RETRY_MS has passed, not by every face that scrolls into view.
const uploads = new Map<string, Upload>()
const RETRY_MS = 30_000

function startUpload(bot: BotRef, version: string): Upload {
  const entry: Upload = { version, waiting: new Set() }
  uploads.set(botRefKey(bot), entry)
  void readBotAvatarPng(bot)
    .then(
      (png) => {
        entry.read = png ? `data:image/png;base64,${png}` : null
      },
      () => {
        entry.failedAt = Date.now()
      }
    )
    .then(() => {
      const waiting = [...entry.waiting]
      entry.waiting.clear()
      waiting.forEach((onRead) => onRead(entry.read ?? null))
    })
  return entry
}

/** Calls `onRead` with the picture once read (reading it if no current read is kept); returns the leave. */
function watchUpload(
  bot: BotRef,
  version: string,
  onRead: (src: string | null) => void
): () => void {
  const cached = uploads.get(botRefKey(bot))
  const entry =
    cached?.version === version &&
    (cached.failedAt === undefined || Date.now() - cached.failedAt < RETRY_MS)
      ? cached
      : startUpload(bot, version)
  if (entry.read === undefined && entry.failedAt === undefined) {
    entry.waiting.add(onRead)
    return () => {
      entry.waiting.delete(onRead)
    }
  }
  let live = true
  queueMicrotask(() => {
    if (live) {
      onRead(entry.read ?? null)
    }
  })
  return () => {
    live = false
  }
}

function readUpload(
  bot: BotRef,
  version: string | null
): { key: string; src: string | null } | null {
  const cached = version ? uploads.get(botRefKey(bot)) : undefined
  return version && cached?.version === version && cached.read !== undefined
    ? { key: version, src: cached.read }
    : null
}

/** The picture's URL; null shows the emoji or initial. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const [upload, setUpload] = useState(() => readUpload({ hostId, id }, uploadKey))
  useEffect(() => {
    if (!uploadKey) {
      return
    }
    return watchUpload({ hostId, id }, uploadKey, (src) =>
      setUpload((shown) =>
        shown?.key === uploadKey && shown.src === src ? shown : { key: uploadKey, src }
      )
    )
  }, [hostId, id, uploadKey])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
