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
}
type OnRead = (version: string, src: string | null) => void

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A finished read is
// kept, so a face drawn again (a row scrolled back into view) shows it at once. A failed read is retried
// by the next face to mount, as before, except a row face drawn as its list scrolls: it waits RETRY_MS,
// so scrolling doesn't read again for every row that comes into view.
const uploads = new Map<string, Upload>()
const RETRY_MS = 30_000
// The faces mounted per bot: each read that finishes reaches them all, so faces showing a failed read
// recover when a later one succeeds. Each face leaves as it unmounts, so scrolling adds none.
const faces = new Map<string, Set<OnRead>>()

function startUpload(bot: BotRef, version: string): Upload {
  const key = botRefKey(bot)
  const entry: Upload = { version }
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
      const watching = faces.get(key)
      watching?.forEach((onRead) => onRead(version, entry.read ?? null))
      forgetFailure(key, watching)
    })
  return entry
}

/** A failure is kept only while a face shows it, so it never outlives the bot's faces. */
function forgetFailure(key: string, watching: Set<OnRead> | undefined): void {
  if (!watching?.size && uploads.get(key)?.failedAt !== undefined) {
    uploads.delete(key)
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
  let live = true
  if (entry.read !== undefined || entry.failedAt !== undefined) {
    queueMicrotask(() => {
      if (live) {
        onRead(version, entry.read ?? null)
      }
    })
  }
  return () => {
    live = false
    watching.delete(onRead)
    if (watching.size === 0 && faces.get(key) === watching) {
      faces.delete(key)
    }
    forgetFailure(key, faces.get(key))
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
