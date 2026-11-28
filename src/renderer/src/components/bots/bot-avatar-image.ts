// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { readBotHostState, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { botHostGeneration, useBotHostGeneration } from '@/lib/bot-host-link-read'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { wornBotOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useBotMascotLayers, type BotOutfitArt, type BotPictureSize } from './bot-mascot-look'

/** A read that failed (its host away or unreachable) says nothing about the picture, so it never
 *  replaces one already shown; one that answered null means the host has no picture for the bot. */
type UploadRead = { src: string | null } | 'failed'

type UploadEntry = {
  version: string
  generation: number
  read: Promise<UploadRead>
  // The finished answer, for a caller that may not ask the host now; undefined until it lands.
  src?: string | null
  loaded: boolean
}

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A version names the
// upload's bytes, so a picture read once is kept; a failed read is dropped so the next try reads
// again, and an empty answer is read again once its host comes back (it may have changed while away).
const uploads = new Map<string, UploadEntry>()
// Told a bot's key (botRefKey) when a picture lands in the cache, so a view showing that bot's initial
// from its own failed or empty read takes the picture another view read.
const loadListeners = new Set<(key: string) => void>()

/** Hears each bot picture that lands in the shared cache, by botRefKey. */
export function subscribeToBotUploadLoads(listener: (key: string) => void): () => void {
  loadListeners.add(listener)
  return () => loadListeners.delete(listener)
}

function uploadRead(bot: BotRef, version: string, generation: number): Promise<UploadRead> {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  if (cached?.version === version && (cached.loaded || cached.generation === generation)) {
    return cached.read
  }
  const entry: UploadEntry = {
    version,
    generation,
    loaded: false,
    read: Promise.resolve<UploadRead>('failed')
  }
  entry.read = readBotAvatarPng(bot).then(
    (png): UploadRead => {
      // An empty answer ('' from a zero-length file) shows no picture, so it is read again like null.
      entry.src = png ? `data:image/png;base64,${png}` : null
      entry.loaded = entry.src !== null
      if (entry.loaded) {
        // The version names the bytes, so a picture read for it stays good even if a later read for
        // the same version (after its host came back) took this one's place and is still out or failed.
        const current = uploads.get(key)
        if (current !== entry && (!current || (current.version === version && !current.loaded))) {
          uploads.set(key, entry)
        }
        if (uploads.get(key) === entry) {
          loadListeners.forEach((listener) => listener(key))
        }
      }
      return { src: entry.src }
    },
    (): UploadRead => {
      if (uploads.get(key) === entry) {
        uploads.delete(key)
      }
      return 'failed'
    }
  )
  uploads.set(key, entry)
  return entry.read
}

/** The picture already loaded for this version, if any: shown without a read, even while its host is away. */
function loadedUploadRead(bot: BotRef, version: string): Promise<UploadRead> | null {
  const cached = uploads.get(botRefKey(bot))
  return cached?.version === version && cached.loaded ? cached.read : null
}

/** The shared cache's finished read of that version, if any: a data URL or null; undefined when none,
 *  or when it answered null before its host last came back (so it is read again). */
export function peekBotUploadSrc(bot: BotRef, version: string): string | null | undefined {
  const cached = uploads.get(botRefKey(bot))
  if (cached?.version !== version) {
    return undefined
  }
  return cached.loaded || cached.generation === botHostGeneration(bot.hostId)
    ? cached.src
    : undefined
}

/** The bot's uploaded picture through the shared cache: a data URL, null for none, undefined when the
 *  read failed. */
export function readBotUploadSrc(bot: BotRef, version: string): Promise<string | null | undefined> {
  return uploadRead(bot, version, botHostGeneration(bot.hostId)).then((read) =>
    read === 'failed' ? undefined : read.src
  )
}

/** Only an away paired server is offline; this computer, or a host not listed, is tried. */
function useBotHostAway(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readBotHostState(hostId) === 'offline'
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}

type AvatarBot = Pick<Bot, 'id' | 'avatar' | 'avatarColor' | 'avatarOutfit'> & BotOnHost

/** The picture with its outfit's art as a second image over it, for a tile that can stack the two. */
export function useBotAvatarLook(
  bot: AvatarBot,
  size: BotPictureSize = 'small'
): { src: string | null; outfit: BotOutfitArt | null } {
  const parsed = parseBotAvatar(bot.avatar)
  const mascot = useBotMascotLayers(
    parsed?.kind === 'mascot' ? parsed.id : null,
    bot.avatarColor,
    wornBotOutfit(bot.avatarOutfit),
    size
  )
  const upload = useUploadSrc(bot)
  return mascot ?? { src: upload, outfit: null }
}

function useUploadSrc(bot: AvatarBot): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const { hostId, id } = bot
  // The picture shown is bound to this host, bot and version.
  const uploadKey =
    parsed?.kind === 'upload' ? `${botRefKey({ hostId, id })}|${parsed.version}` : null
  const version = parsed?.kind === 'upload' ? parsed.version : null
  const [upload, setUpload] = useState<{ key: string; src: string | null } | null>(null)
  const away = useBotHostAway(hostId)
  // A paired server's picture read while it was away (as at launch, from its kept list) failed;
  // its coming back reads it again, so the row never stays on the initial.
  const generation = useBotHostGeneration(hostId)
  useEffect(() => {
    if (!uploadKey || !version) {
      return
    }
    const ref = { hostId, id }
    let live = true
    // A version names the bytes, so a picture shown for it stays: an empty answer for the same version
    // never hides it, whatever the shared cache holds by then (another view may have put an older
    // version of this bot there).
    const show = (src: string | null): void => {
      if (live) {
        setUpload((shown) =>
          src === null && shown?.key === uploadKey && shown.src ? shown : { key: uploadKey, src }
        )
      }
    }
    // A picture loaded for this version by any read (another view's, or one from before the host came
    // back that answered late) shows here too.
    const showLoaded = (): boolean => {
      const loaded = peekBotUploadSrc(ref, version)
      if (loaded) {
        show(loaded)
      }
      return Boolean(loaded)
    }
    const key = botRefKey(ref)
    const stopLoads = subscribeToBotUploadLoads((loadedKey) => {
      if (loadedKey === key) {
        showLoaded()
      }
    })
    // An away server can't answer, but a picture already loaded from it still shows.
    const pending = away ? loadedUploadRead(ref, version) : uploadRead(ref, version, generation)
    void pending?.then((read) => {
      if (read !== 'failed' && (read.src || !showLoaded())) {
        show(read.src)
      }
    })
    return () => {
      live = false
      stopLoads()
    }
  }, [hostId, id, uploadKey, version, away, generation])
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
