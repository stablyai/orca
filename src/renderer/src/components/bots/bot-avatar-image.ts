// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
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
  /** The groups whose row faces asked for this read: a failure is noted there even after the rows
   *  scrolled away, so the next row scrolled in doesn't read it again. Let go as the read settles. */
  noted: Set<BotAvatarFailures>
}

/** The latest failed read's version per bot (by botRefKey), at most MAX_FAILURES, oldest let go first. */
export type BotAvatarFailures = Map<string, { version: string; hostId: BotRef['hostId'] }>
const MAX_FAILURES = 64

/** `paused`: don't read now (the host is offline). `failures`: a group's failed reads: one listed for
 *  its bot isn't read again while the group is shown, a failed read is listed and a successful one
 *  unlisted. */
export type BotAvatarRead = {
  paused?: boolean
  failures?: BotAvatarFailures | null
  /** A chat turn's picture as it was when posted: the bot's current one, if read, shows instead. */
  historical?: boolean
}

/** A group's failures leaving (it folded or closed): pending reads stop holding them. */
export function forgetBotAvatarFailures(failures: BotAvatarFailures): void {
  pendingByFailures.get(failures)?.forEach((upload) => upload.noted.delete(failures))
  pendingByFailures.delete(failures)
}

// Each group's watcher of the hosts its failures are on.
const failureHostWatchers = new WeakMap<BotAvatarFailures, (hostId: BotRef['hostId']) => void>()

/** Calls `onHost` with each host a failure is noted on; returns the leave. */
export function watchBotAvatarFailureHosts(
  failures: BotAvatarFailures,
  onHost: (hostId: BotRef['hostId']) => void
): () => void {
  failureHostWatchers.set(failures, onHost)
  failures.forEach((failure) => onHost(failure.hostId))
  return () => {
    failureHostWatchers.delete(failures)
  }
}

function noteFailure(failures: BotAvatarFailures, bot: BotRef, key: string, version: string): void {
  failureHostWatchers.get(failures)?.(bot.hostId)
  failures.delete(key)
  failures.set(key, { version, hostId: bot.hostId })
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
// Each group's reads in flight, which it lets go of as it leaves.
const pendingByFailures = new WeakMap<BotAvatarFailures, Set<Upload>>()

// The version each bot's current faces (rows, badges, settings: all from the catalog) last asked for.
const currentVersions = new Map<string, string>()

/** A chat turn from before the picture changed asks for an old version, which the host can't give: it
 *  reads the bot's current picture. So the current one, already read, is what that turn shows, and the
 *  rows showing the current one keep it. */
function currentFor(key: string): Upload | undefined {
  const cached = uploads.get(key)
  return cached?.read !== undefined && currentVersions.get(key) === cached.version
    ? cached
    : undefined
}

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
        if (failures.get(key)?.version === version) {
          failures.delete(key)
        }
      })
      started.noted.forEach((failures) => pendingByFailures.get(failures)?.delete(started))
      started.noted.clear()
      settle(started, started.read, false)
    },
    () => {
      if (uploads.get(key) === started) {
        uploads.delete(key)
      }
      // A read that failed because its host went away is read again when the host is back.
      if (readBotHostState(bot.hostId) === 'live') {
        started.noted.forEach((failures) => noteFailure(failures, bot, key, version))
      }
      started.noted.forEach((failures) => pendingByFailures.get(failures)?.delete(started))
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
  historical: boolean,
  onRead: (src: string | null, failed: boolean) => void
): () => void {
  const key = botRefKey(bot)
  if (!historical) {
    currentVersions.set(key, version)
  }
  const entry =
    uploadOf(key, version) ??
    (historical ? currentFor(key) : undefined) ??
    startUpload(bot, key, version)
  if (failures && entry.read === undefined) {
    entry.noted.add(failures)
    const reads = pendingByFailures.get(failures) ?? new Set<Upload>()
    pendingByFailures.set(failures, reads.add(entry))
  }
  if (entry.read !== undefined) {
    // Already read: given at once, which a face mounting from it ignores without a render.
    onRead(entry.read, false)
    return () => {}
  }
  entry.waiting.add(onRead)
  return () => {
    entry.waiting.delete(onRead)
  }
}

function finishedUpload(
  bot: BotRef,
  version: string | null,
  historical: boolean
): { key: string; src: string | null } | null {
  const key = botRefKey(bot)
  const cached = version
    ? (uploadOf(key, version) ?? (historical ? currentFor(key) : undefined))
    : undefined
  return version && cached?.read !== undefined ? { key: version, src: cached.read } : null
}

/** Whether the bot's picture at `version` is already read: a face showing it needs no host or window. */
export function isBotAvatarRead(bot: BotRef, version: string | null): boolean {
  return version !== null && uploadOf(botRefKey(bot), version)?.read !== undefined
}

/** The picture's URL; null shows the emoji or initial. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost,
  read?: BotAvatarRead
): string | null {
  const paused = read?.paused === true
  const failures = read?.failures ?? null
  const historical = read?.historical === true
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const { hostId, id } = bot
  const [upload, setUpload] = useState(() => finishedUpload({ hostId, id }, uploadKey, historical))
  useEffect(() => {
    const key = botRefKey({ hostId, id })
    if (!uploadKey || paused || failures?.get(key)?.version === uploadKey) {
      return
    }
    return readUpload({ hostId, id }, uploadKey, failures, historical, (src) => {
      setUpload((shown) =>
        shown?.key === uploadKey && shown.src === src ? shown : { key: uploadKey, src }
      )
    })
  }, [hostId, id, uploadKey, paused, failures, historical])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
