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
}

/** `paused`: don't read now (the host is offline). `failures`: reads that failed, by `botAvatarReadKey`;
 *  one listed there isn't read again, and a failed read is added. */
export type BotAvatarRead = { paused: boolean; failures: Set<string> | null }

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A finished read is
// kept, so a face drawn again (a row scrolled back into view) shows it at once; a failed read is
// dropped, so the next face reads again.
const uploads = new Map<string, Upload>()

export function botAvatarReadKey(bot: BotRef, version: string): string {
  return `${botRefKey(bot)}\n${version}`
}

function uploadOf(key: string, version: string): Upload | undefined {
  const cached = uploads.get(key)
  return cached?.version === version ? cached : undefined
}

function startUpload(bot: BotRef, key: string, version: string): Upload {
  const started: Upload = { version, waiting: new Set() }
  uploads.set(key, started)
  void readBotAvatarPng(bot).then(
    (png) => {
      started.read = png ? `data:image/png;base64,${png}` : null
      settle(started, started.read, false)
    },
    () => {
      if (uploads.get(key) === started) {
        uploads.delete(key)
      }
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
  onRead: (src: string | null, failed: boolean) => void
): () => void {
  const key = botRefKey(bot)
  const entry = uploadOf(key, version) ?? startUpload(bot, key, version)
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
    if (!uploadKey || paused || failures?.has(botAvatarReadKey({ hostId, id }, uploadKey))) {
      return
    }
    return readUpload({ hostId, id }, uploadKey, (src, failed) => {
      if (failed) {
        failures?.add(botAvatarReadKey({ hostId, id }, uploadKey))
      }
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
