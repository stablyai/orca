// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

type Upload = {
  version: string
  /** The finished read, so a face drawn again (a row scrolled back into view) shows it at once. */
  read?: string | null
  /** Faces waiting on the read; each leaves as it unmounts. */
  waiting: Set<(src: string | null) => void>
}

// Each bot's current upload only (by botRefKey), so a replaced picture is let go; a failed read is retried by
// the next face (rows: after RETRY_MS).
const uploads = new Map<string, Upload>()

// Each bot's last failed read, which rows mounting as a list scrolls don't send again for RETRY_MS. At
// most MAX_FAILURES, oldest let go first.
const failures = new Map<string, { version: string; at: number }>()
const RETRY_MS = 10_000
const MAX_FAILURES = 64
// Rows that skipped reading a recently failed version, by botRefKey; each leaves as it unmounts.
const skippedFaces = new Map<string, Set<{ version: string; show: (src: string | null) => void }>>()

function noteFailure(key: string, version: string): void {
  failures.delete(key)
  failures.set(key, { version, at: performance.now() })
  for (const oldest of failures.keys()) {
    if (failures.size <= MAX_FAILURES) {
      break
    }
    failures.delete(oldest)
  }
}

function failedLately(key: string, version: string): boolean {
  const failure = failures.get(key)
  return failure?.version === version && performance.now() - failure.at < RETRY_MS
}

function startUpload(bot: BotRef, key: string, version: string): Upload {
  const upload: Upload = { version, waiting: new Set() }
  uploads.set(key, upload)
  const done = (src: string | null): void => {
    upload.waiting.forEach((face) => face(src))
    upload.waiting.clear()
  }
  readBotAvatarPng(bot).then(
    (png) => {
      if (failures.get(key)?.version === version) {
        failures.delete(key)
      }
      upload.read = png ? `data:image/png;base64,${png}` : null
      done(upload.read)
      skippedFaces.get(key)?.forEach((face) => {
        if (face.version === version) {
          face.show(upload.read ?? null)
        }
      })
    },
    () => {
      // A read another version replaced says nothing about the bot's current picture.
      if (uploads.get(key) === upload) {
        uploads.delete(key)
        noteFailure(key, version)
      }
      done(null)
    }
  )
  return upload
}

function readUpload(bot: BotRef, version: string | null): string | null | undefined {
  const cached = version ? uploads.get(botRefKey(bot)) : undefined
  return cached?.version === version ? cached.read : undefined
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
    const key = botRefKey({ hostId, id })
    const cached = uploads.get(key)
    if (cached?.version === uploadKey && cached.read !== undefined) {
      show(cached.read)
      return
    }
    if (cached?.version !== uploadKey && backoff && failedLately(key, uploadKey)) {
      // No read now, but another face's read of this version still reaches it.
      const skipped = skippedFaces.get(key) ?? new Set()
      const face = { version: uploadKey, show }
      skippedFaces.set(key, skipped.add(face))
      return () => {
        skipped.delete(face)
        if (skipped.size === 0 && skippedFaces.get(key) === skipped) {
          skippedFaces.delete(key)
        }
      }
    }
    const reading =
      cached?.version === uploadKey ? cached : startUpload({ hostId, id }, key, uploadKey)
    reading.waiting.add(show)
    return () => {
      reading.waiting.delete(show)
    }
  }, [hostId, id, uploadKey, backoff])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
