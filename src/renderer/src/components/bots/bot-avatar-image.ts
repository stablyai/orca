// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useCallback, useState, useSyncExternalStore } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { readBotHostState, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

type Picture = {
  bot: BotRef
  version: string
  /** The successful read: a data URL, or null for none. */
  src?: string | null
  reading: boolean
  /** The latest read failed: when (performance.now()) and how many times in a row. */
  failedAt: number | null
  failures: number
  /** Timed retries since the last success; rows stop after MAX_TIMED_RETRIES and read again as they mount. */
  timedRetries: number
  /** A retry while rows wait, or the forgetting of a failure no face waits on. */
  timer: ReturnType<typeof setTimeout> | null
}
type Face = { version: string; backoff: boolean; notify: () => void }

const RETRY_MS = 10_000
const MAX_RETRY_MS = 300_000
const MAX_TIMED_RETRIES = 3

// Each bot's latest asked version only (by botRefKey), so a replaced picture is let go, as one cache slot
// per bot always was. A failure no face waits on is let go after RETRY_MS.
const pictures = new Map<string, Picture>()
// Each bot's mounted faces; each leaves as it unmounts.
const facesByBot = new Map<string, Set<Face>>()
// Pictures rows wait on until their host comes back.
const heldByHost = new Set<Picture>()

const retryDelay = (picture: Picture): number =>
  Math.min(RETRY_MS * 2 ** Math.max(0, picture.failures - 1), MAX_RETRY_MS)
const hostOffline = (picture: Picture): boolean =>
  readBotHostState(picture.bot.hostId) === 'offline'

function facesOf(picture: Picture): Face[] {
  const faces = facesByBot.get(botRefKey(picture.bot))
  return faces ? [...faces].filter((face) => face.version === picture.version) : []
}

function clearTimer(picture: Picture): void {
  if (picture.timer !== null) {
    clearTimeout(picture.timer)
    picture.timer = null
  }
}

function forget(picture: Picture): void {
  clearTimer(picture)
  heldByHost.delete(picture)
  const key = botRefKey(picture.bot)
  if (pictures.get(key) === picture) {
    pictures.delete(key)
  }
  watchHosts()
}

function pictureOf(bot: BotRef, version: string): Picture {
  const key = botRefKey(bot)
  const found = pictures.get(key)
  if (found?.version === version) {
    return found
  }
  if (found) {
    forget(found)
  }
  const picture: Picture = {
    bot: { hostId: bot.hostId, id: bot.id },
    version,
    reading: false,
    failedAt: null,
    failures: 0,
    timedRetries: 0,
    timer: null
  }
  pictures.set(key, picture)
  return picture
}

/** After a failure, rows waiting retry once the delay passes, a few times; other faces read as they mount. */
function scheduleRetry(picture: Picture): void {
  if (
    picture.timer !== null ||
    picture.failedAt === null ||
    picture.timedRetries >= MAX_TIMED_RETRIES ||
    !facesOf(picture).some((face) => face.backoff)
  ) {
    return
  }
  const left = retryDelay(picture) - (performance.now() - picture.failedAt)
  picture.timer = setTimeout(
    () => {
      picture.timer = null
      picture.timedRetries += 1
      if (pictures.get(botRefKey(picture.bot)) === picture && facesOf(picture).length > 0) {
        admit(picture, false, true)
      }
    },
    Math.max(0, left)
  )
}

/** Starts a read unless one is running or done. `now`: a face that reads on every mount, as pictures
 *  outside long lists do. Otherwise not while the host is offline (it reads as the host comes back) or
 *  until the delay after a failure has passed (`due`: it has). */
function admit(picture: Picture, now: boolean, due = false): void {
  if (picture.src !== undefined || picture.reading) {
    return
  }
  if (!now) {
    if (hostOffline(picture)) {
      heldByHost.add(picture)
      watchHosts()
      return
    }
    if (
      !due &&
      picture.failedAt !== null &&
      performance.now() - picture.failedAt < retryDelay(picture)
    ) {
      scheduleRetry(picture)
      return
    }
  }
  clearTimer(picture)
  heldByHost.delete(picture)
  picture.reading = true
  readBotAvatarPng(picture.bot).then(
    (png) => settle(picture, png ? `data:image/png;base64,${png}` : null),
    () => settle(picture, undefined)
  )
  watchHosts()
}

function settle(picture: Picture, src: string | null | undefined): void {
  picture.reading = false
  if (pictures.get(botRefKey(picture.bot)) !== picture) {
    return
  }
  if (src === undefined) {
    picture.failedAt = performance.now()
    picture.failures += 1
    if (facesOf(picture).length === 0) {
      picture.timer = setTimeout(() => forget(picture), RETRY_MS)
    } else if (facesOf(picture).some((face) => face.backoff) && hostOffline(picture)) {
      heldByHost.add(picture)
      watchHosts()
    } else {
      scheduleRetry(picture)
    }
  } else {
    picture.src = src
    picture.failedAt = null
    picture.failures = 0
    picture.timedRetries = 0
  }
  facesByBot.get(botRefKey(picture.bot))?.forEach((face) => face.notify())
}

// While rows wait on a host that is offline, its coming back reads their pictures at once.
let stopHosts: (() => void) | null = null
function watchHosts(): void {
  if (heldByHost.size > 0 && !stopHosts) {
    stopHosts = subscribeToBotChanges(() => {
      for (const picture of heldByHost) {
        if (!hostOffline(picture)) {
          heldByHost.delete(picture)
          picture.failedAt = null
          admit(picture, false)
        }
      }
      watchHosts()
    })
  } else if (heldByHost.size === 0 && stopHosts) {
    stopHosts()
    stopHosts = null
  }
}

function watch(bot: BotRef, face: Face): () => void {
  const key = botRefKey(bot)
  const faces = facesByBot.get(key) ?? new Set<Face>()
  facesByBot.set(key, faces)
  faces.add(face)
  const picture = pictureOf(bot, face.version)
  if (picture.failedAt !== null && picture.timer !== null && facesOf(picture).length === 1) {
    // A failure kept only to be forgotten: a face waits on it again.
    clearTimer(picture)
  }
  admit(picture, !face.backoff)
  return () => {
    faces.delete(face)
    if (faces.size === 0) {
      facesByBot.delete(key)
    }
    if (
      pictures.get(key) === picture &&
      picture.src === undefined &&
      !picture.reading &&
      facesOf(picture).length === 0
    ) {
      clearTimer(picture)
      heldByHost.delete(picture)
      watchHosts()
      if (picture.failedAt === null) {
        forget(picture)
      } else {
        const left = RETRY_MS - (performance.now() - picture.failedAt)
        picture.timer = setTimeout(() => forget(picture), Math.max(0, left))
      }
    }
  }
}

const noop = (): void => {}

/** The picture's URL; null shows the emoji or initial. `backoff`: rows that mount as a list scrolls
 *  don't read while the host is offline (they read as it comes back) or soon after a failed read. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  backoff = false
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  // The last picture this face showed, kept while another version takes the bot's one cache slot.
  const [shown] = useState<{ version: string | null; src: string | null }>(() => ({
    version: null,
    src: null
  }))
  const subscribe = useCallback(
    (notify: () => void) =>
      uploadKey ? watch({ hostId, id }, { version: uploadKey, backoff, notify }) : noop,
    [hostId, id, uploadKey, backoff]
  )
  const read = useCallback((): string | null => {
    if (!uploadKey) {
      return null
    }
    const picture = pictures.get(botRefKey({ hostId, id }))
    if (picture?.version === uploadKey && picture.src !== undefined) {
      shown.version = uploadKey
      shown.src = picture.src
    }
    return shown.version === uploadKey ? shown.src : null
  }, [hostId, id, uploadKey, shown])
  const src = useSyncExternalStore(subscribe, read, read)
  return mascotSrc ?? src
}
