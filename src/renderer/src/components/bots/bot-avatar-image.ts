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
  /** Faces waiting on the read in flight; each leaves as it unmounts. `failed`: the read failed. */
  waiting: Set<(src: string | null, failed: boolean) => void>
  /** The long groups whose rows asked for this read: a failure is noted there even after the rows
   *  scrolled away, so the next row scrolled in doesn't read it again. Let go as the read settles. */
  noted: Set<BotAvatarFailures>
}

/** The latest failed read's version per bot (by botRefKey), at most MAX_FAILURES, oldest let go first. */
export type BotAvatarFailures = Map<string, string>
const MAX_FAILURES = 64

/** `paused`: don't read now (the host is offline). `failures`: a version listed there for its bot isn't
 *  read again; a failed read is listed and a successful one unlisted. */
export type BotAvatarRead = { paused: boolean; failures: BotAvatarFailures | null }

function noteFailure(failures: BotAvatarFailures, key: string, version: string): void {
  failures.delete(key)
  failures.set(key, version)
  for (const oldest of failures.keys()) {
    if (failures.size <= MAX_FAILURES) {
      break
    }
    failures.delete(oldest)
  }
}

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A finished read is
// kept, so a face drawn again (a row scrolled back into view) shows it at once; a failed read is
// dropped, so the next face reads again.
const uploads = new Map<string, Upload>()

function uploadOf(key: string, version: string): Upload | undefined {
  const cached = uploads.get(key)
  return cached?.version === version ? cached : undefined
}

function startUpload(bot: BotRef, key: string, version: string): Upload {
  const started: Upload = { version, waiting: new Set(), noted: new Set() }
  uploads.set(key, started)
  void readBotAvatarPng(bot).then(
    (png) => {
      started.read = png ? `data:image/png;base64,${png}` : null
      started.noted.forEach((failures) => {
        if (failures.get(key) === version) {
          failures.delete(key)
        }
      })
      started.noted.clear()
      settle(started, started.read, false)
    },
    () => {
      if (uploads.get(key) === started) {
        uploads.delete(key)
      }
      started.noted.forEach((failures) => noteFailure(failures, key, version))
      started.noted.clear()
      settle(started, null, true)
    }
  )
  return started
}

function settle(entry: Upload, src: string | null, failed: boolean): void {
  const waiting = [...entry.waiting]
  entry.waiting.clear()
  waiting.forEach((onRead) => onRead(src, failed))
}

function readUpload(
  bot: BotRef,
  version: string,
  failures: BotAvatarFailures | null,
  onRead: (src: string | null, failed: boolean) => void
): () => void {
  const key = botRefKey(bot)
  const entry = uploadOf(key, version) ?? startUpload(bot, key, version)
  if (failures && entry.read === undefined) {
    entry.noted.add(failures)
  }
  if (entry.read !== undefined) {
    const read = entry.read
    let live = true
    queueMicrotask(() => {
      if (live) {
        onRead(read, false)
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
  const failures = read?.failures ?? null
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const [upload, setUpload] = useState(() => finishedUpload({ hostId, id }, uploadKey))
  useEffect(() => {
    const key = botRefKey({ hostId, id })
    if (!uploadKey || paused || failures?.get(key) === uploadKey) {
      return
    }
    return readUpload({ hostId, id }, uploadKey, failures, (src) => {
      setUpload((shown) =>
        shown?.key === uploadKey && shown.src === src ? shown : { key: uploadKey, src }
      )
    })
  }, [hostId, id, uploadKey, paused, failures])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
