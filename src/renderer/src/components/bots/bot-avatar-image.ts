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
  /** The read failed: the next face to mount reads again, except a row drawn as its list scrolls. */
  failed?: true
  /** Faces waiting on the read in flight; each leaves as it unmounts. */
  waiting: Set<(src: string | null) => void>
}

/** `paused`: don't read now (the host is offline). `keepFailure`: a failed read shows the fallback until
 *  the host comes back or another face reads it, instead of reading again on mount (rows drawn as a long
 *  list scrolls, which would each read it again). */
export type BotAvatarRead = { paused: boolean; keepFailure: boolean }

// Each bot's latest two picture versions (by botRefKey): a chat turn from before a picture changed asks
// for the old one without dropping the current one. A finished read is kept, so a face drawn again (a
// row scrolled back into view) shows it at once.
const uploads = new Map<string, Upload[]>()
const KEPT_VERSIONS = 2

function uploadOf(key: string, version: string): Upload | undefined {
  return uploads.get(key)?.find((upload) => upload.version === version)
}

function startUpload(bot: BotRef, key: string, version: string): Upload {
  const started: Upload = { version, waiting: new Set() }
  const kept = (uploads.get(key) ?? []).filter((upload) => upload.version !== version)
  uploads.set(key, [started, ...kept].slice(0, KEPT_VERSIONS))
  void readBotAvatarPng(bot).then(
    (png) => {
      started.read = png ? `data:image/png;base64,${png}` : null
      settle(started, started.read)
    },
    () => {
      started.failed = true
      settle(started, null)
    }
  )
  return started
}

function settle(entry: Upload, src: string | null): void {
  const waiting = [...entry.waiting]
  entry.waiting.clear()
  waiting.forEach((onRead) => onRead(src))
}

function readUpload(
  bot: BotRef,
  version: string,
  keepFailure: boolean,
  onRead: (src: string | null) => void
): () => void {
  const key = botRefKey(bot)
  const cached = uploadOf(key, version)
  const entry = cached && (!cached.failed || keepFailure) ? cached : startUpload(bot, key, version)
  if (entry.read !== undefined || entry.failed) {
    const read = entry.read ?? null
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
  entry.waiting.add(onRead)
  return () => {
    entry.waiting.delete(onRead)
  }
}

/** The host went away: a failed read of its bot's picture is tried again once the host is back. */
export function forgetBotAvatarFailure(bot: BotRef): void {
  const key = botRefKey(bot)
  const kept = uploads.get(key)?.filter((upload) => !upload.failed)
  if (kept?.length) {
    uploads.set(key, kept)
  } else {
    uploads.delete(key)
  }
}

function finishedUpload(
  bot: BotRef,
  version: string | null
): { key: string; src: string | null } | null {
  const cached = version ? uploadOf(botRefKey(bot), version) : undefined
  return version && cached?.read !== undefined ? { key: version, src: cached.read } : null
}

/** The picture's URL; null shows the emoji or initial. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  read?: BotAvatarRead
): string | null {
  const paused = read?.paused === true
  const keepFailure = read?.keepFailure === true
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const [upload, setUpload] = useState(() => finishedUpload({ hostId, id }, uploadKey))
  useEffect(() => {
    if (!uploadKey || paused) {
      return
    }
    return readUpload({ hostId, id }, uploadKey, keepFailure, (src) =>
      setUpload((shown) =>
        shown?.key === uploadKey && shown.src === src ? shown : { key: uploadKey, src }
      )
    )
  }, [hostId, id, uploadKey, paused, keepFailure])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
