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
  /** Faces that joined while the read was in flight: the ones a failure reaches. */
  waiting: Set<OnRead>
}
type OnRead = (version: string, src: string | null) => void

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A finished read is
// kept, so a face drawn again (a row scrolled back into view) shows it at once. A failed read is retried
// by the next face to mount, as before, except a row face drawn as its list scrolls: it waits RETRY_MS,
// so scrolling doesn't read again for every row that comes into view.
const uploads = new Map<string, Upload>()
const RETRY_MS = 30_000
// The faces mounted per bot: each successful read reaches them all, so faces showing a failed read
// recover when a later one succeeds; a failure reaches only the faces waiting on it. Each face leaves
// as it unmounts, so scrolling adds none.
const faces = new Map<string, Set<OnRead>>()

function startUpload(bot: BotRef, version: string): Upload {
  const key = botRefKey(bot)
  const entry: Upload = { version, waiting: new Set() }
  uploads.set(key, entry)
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
      if (uploads.get(key) === entry) {
        if (entry.failedAt === undefined) {
          failed.delete(key)
        } else {
          keepFailure(key)
        }
      }
      const reached = entry.failedAt === undefined ? faces.get(key) : entry.waiting
      const settled = [...(reached ?? [])]
      entry.waiting.clear()
      settled.forEach((onRead) => onRead(version, entry.read ?? null))
    })
  return entry
}

// Bots whose current read failed, oldest first: a few are kept after their faces leave (so a row
// scrolled back waits to retry), and past KEPT_FAILURES the oldest no face shows is forgotten.
const failed = new Set<string>()
const KEPT_FAILURES = 32

function keepFailure(key: string): void {
  failed.delete(key)
  failed.add(key)
  trimFailures()
}

function trimFailures(): void {
  for (const old of failed) {
    if (failed.size <= KEPT_FAILURES) {
      break
    }
    if (!faces.has(old)) {
      failed.delete(old)
      uploads.delete(old)
    }
  }
}

/** Calls `onRead` with each read of the bot's picture that finishes (reading this version if no current
 *  read is kept, at once if one is); returns the leave. */
function watchUpload(
  bot: BotRef,
  version: string,
  onRead: OnRead,
  waitToRetry: boolean
): () => void {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  const entry =
    cached?.version === version &&
    (cached.failedAt === undefined || (waitToRetry && Date.now() - cached.failedAt < RETRY_MS))
      ? cached
      : startUpload(bot, version)
  const watching = faces.get(key) ?? new Set<OnRead>()
  faces.set(key, watching)
  watching.add(onRead)
  const pending = entry.read === undefined && entry.failedAt === undefined
  if (pending) {
    entry.waiting.add(onRead)
  }
  let live = true
  if (!pending) {
    queueMicrotask(() => {
      if (live) {
        onRead(version, entry.read ?? null)
      }
    })
  }
  return () => {
    live = false
    entry.waiting.delete(onRead)
    watching.delete(onRead)
    if (watching.size === 0 && faces.get(key) === watching) {
      faces.delete(key)
      trimFailures()
    }
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

/** The picture's URL; null shows the emoji or initial. `waitToRetry`: a face drawn as its list scrolls,
 *  which retries a failed read only after a while. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  waitToRetry = false
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
    return watchUpload(
      { hostId, id },
      uploadKey,
      (version, src) => {
        if (version === uploadKey) {
          setUpload((shown) =>
            shown?.key === uploadKey && shown.src === src ? shown : { key: uploadKey, src }
          )
        }
      },
      waitToRetry
    )
  }, [hostId, id, uploadKey, waitToRetry])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
