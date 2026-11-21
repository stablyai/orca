// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useCallback, useSyncExternalStore } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { readBotHostState, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

type Upload = {
  bot: BotRef
  version: string
  /** The successful read: a data URL, or null for none. */
  src?: string | null
  reading: boolean
  /** The latest read failed: when, how many times in a row, and whether the host was offline then. */
  failedAt: number | null
  failures: number
  failedOffline: boolean
  /** A face waiting skipped reading because the host was offline. */
  skippedOffline: boolean
  /** The retry after a failure while faces wait, or the forgetting of a failure no face waits on. */
  timer: ReturnType<typeof setTimeout> | null
  /** Faces showing this version; each leaves as it unmounts. */
  faces: Set<() => void>
}

const RETRY_MS = 10_000
const MAX_RETRY_MS = 300_000

// Each bot's versions (by botRefKey): the ones faces show, plus its last read. A version no face shows
// is let go as another is asked for, and a failure no face waits on is let go after RETRY_MS.
const uploads = new Map<string, Map<string, Upload>>()

const retryDelay = (upload: Upload): number =>
  Math.min(RETRY_MS * 2 ** Math.max(0, upload.failures - 1), MAX_RETRY_MS)
const hostOffline = (upload: Upload): boolean => readBotHostState(upload.bot.hostId) === 'offline'

function uploadOf(bot: BotRef, version: string): Upload {
  const key = botRefKey(bot)
  const versions = uploads.get(key) ?? new Map<string, Upload>()
  uploads.set(key, versions)
  for (const [other, upload] of versions) {
    if (other !== version && upload.faces.size === 0) {
      clearTimer(upload)
      versions.delete(other)
    }
  }
  const found = versions.get(version)
  if (found) {
    return found
  }
  const upload: Upload = {
    bot: { hostId: bot.hostId, id: bot.id },
    version,
    reading: false,
    failedAt: null,
    failures: 0,
    failedOffline: false,
    skippedOffline: false,
    timer: null,
    faces: new Set()
  }
  versions.set(version, upload)
  return upload
}

function forget(upload: Upload): void {
  const versions = uploads.get(botRefKey(upload.bot))
  if (versions?.get(upload.version) === upload) {
    versions.delete(upload.version)
    if (versions.size === 0) {
      uploads.delete(botRefKey(upload.bot))
    }
  }
}

function clearTimer(upload: Upload): void {
  if (upload.timer !== null) {
    clearTimeout(upload.timer)
    upload.timer = null
  }
}

/** Starts a read unless one is running or done. `now`: a face that reads on every mount, as pictures
 *  outside long lists do. Otherwise not while the host is offline or soon after a failure. */
function admit(upload: Upload, now: boolean): void {
  if (upload.src !== undefined || upload.reading) {
    return
  }
  if (!now) {
    if (hostOffline(upload)) {
      upload.skippedOffline = true
      return
    }
    if (upload.failedAt !== null && Date.now() - upload.failedAt < retryDelay(upload)) {
      return
    }
  }
  upload.skippedOffline = false
  upload.reading = true
  clearTimer(upload)
  watchHosts()
  readBotAvatarPng(upload.bot).then(
    (png) => settle(upload, png ? `data:image/png;base64,${png}` : null),
    () => settle(upload, undefined)
  )
}

function settle(upload: Upload, src: string | null | undefined): void {
  upload.reading = false
  if (src === undefined) {
    upload.failedAt = Date.now()
    upload.failures += 1
    upload.failedOffline = hostOffline(upload)
    // Faces still waiting retry once the delay passes; with none, the failure is forgotten then.
    upload.timer = setTimeout(
      () => {
        upload.timer = null
        if (upload.faces.size > 0) {
          admit(upload, false)
        } else {
          forget(upload)
        }
      },
      upload.faces.size > 0 ? retryDelay(upload) : RETRY_MS
    )
  } else {
    upload.src = src
    upload.failedAt = null
    upload.failures = 0
  }
  upload.faces.forEach((face) => face())
  watchHosts()
}

// While a face waits on a read the host's state held up, a host coming back reads it at once.
let stopHosts: (() => void) | null = null
function waiting(): Upload[] {
  const found: Upload[] = []
  uploads.forEach((versions) =>
    versions.forEach((upload) => {
      if (upload.faces.size > 0 && upload.src === undefined && !upload.reading) {
        found.push(upload)
      }
    })
  )
  return found
}
function watchHosts(): void {
  const any = waiting().some((upload) => upload.skippedOffline || upload.failedOffline)
  if (any && !stopHosts) {
    stopHosts = subscribeToBotChanges(() => {
      for (const upload of waiting()) {
        if ((upload.skippedOffline || upload.failedOffline) && !hostOffline(upload)) {
          upload.failedAt = null
          upload.failedOffline = false
          admit(upload, false)
        }
      }
      watchHosts()
    })
  } else if (!any && stopHosts) {
    stopHosts()
    stopHosts = null
  }
}

function watch(bot: BotRef, version: string, face: () => void, now: boolean): () => void {
  const upload = uploadOf(bot, version)
  upload.faces.add(face)
  if (upload.failedAt !== null && upload.faces.size === 1 && upload.timer !== null) {
    // A failure kept only to be forgotten: a face waits on it again, so it retries after its delay.
    clearTimer(upload)
    const left = retryDelay(upload) - (Date.now() - upload.failedAt)
    upload.timer = setTimeout(
      () => {
        upload.timer = null
        if (upload.faces.size > 0) {
          admit(upload, false)
        }
      },
      Math.max(0, left)
    )
  }
  admit(upload, now)
  watchHosts()
  return () => {
    upload.faces.delete(face)
    if (upload.faces.size === 0 && upload.src === undefined && !upload.reading) {
      clearTimer(upload)
      if (upload.failedAt === null) {
        forget(upload)
      } else {
        upload.timer = setTimeout(
          () => forget(upload),
          Math.max(0, RETRY_MS - (Date.now() - upload.failedAt))
        )
      }
    }
    watchHosts()
  }
}

const noop = (): void => {}

/** The picture's URL; null shows the emoji or initial. `backoff`: rows that mount as a list scrolls
 *  don't read while the host is offline or soon after a failed read, and read once it comes back. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  backoff = false
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const subscribe = useCallback(
    (face: () => void) => (uploadKey ? watch({ hostId, id }, uploadKey, face, !backoff) : noop),
    [hostId, id, uploadKey, backoff]
  )
  const read = useCallback(
    () => (uploadKey ? uploads.get(botRefKey({ hostId, id }))?.get(uploadKey)?.src : null) ?? null,
    [hostId, id, uploadKey]
  )
  const src = useSyncExternalStore(subscribe, read, read)
  return mascotSrc ?? (uploadKey ? src : null)
}
