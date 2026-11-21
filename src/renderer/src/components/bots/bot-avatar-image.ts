// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { readBotHostState, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { useBotHostGeneration } from '@/lib/bot-host-link-read'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { botMascotSrc } from './bot-mascot-color'

/** A read that failed (its host away or unreachable) says nothing about the picture, so it never
 *  replaces one already shown; one that answered null means the host has no picture for the bot. */
type UploadRead = { src: string | null } | 'failed'

// Each bot's current upload only (by botRefKey), so a replaced picture is let go. A version names the
// upload's bytes, so a picture read once is kept; a failed read is dropped so the next try reads
// again, and an empty answer is read again once its host comes back (it may have changed while away).
const uploads = new Map<
  string,
  { version: string; generation: number; read: Promise<UploadRead>; loaded: boolean }
>()

function uploadRead(bot: BotRef, version: string, generation: number): Promise<UploadRead> {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  if (cached?.version === version && (cached.loaded || cached.generation === generation)) {
    return cached.read
  }
  const entry = { version, generation, loaded: false, read: Promise.resolve<UploadRead>('failed') }
  entry.read = readBotAvatarPng(bot).then(
    (png): UploadRead => {
      entry.loaded = png !== null
      return { src: png ? `data:image/png;base64,${png}` : null }
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

/** Only an away paired server is offline; this computer, or a host not listed, is tried. */
function useBotHostAway(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readBotHostState(hostId) === 'offline'
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}

/** The picture's URL; null shows the emoji or initial. */
export function useBotAvatarSrc(
  bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost
): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
  const uploadKey = parsed?.kind === 'upload' ? parsed.version : null
  const [upload, setUpload] = useState<{ key: string; src: string | null } | null>(null)
  const { hostId, id } = bot
  const away = useBotHostAway(hostId)
  // A paired server's picture read while it was away (as at launch, from its kept list) failed;
  // its coming back reads it again, so the row never stays on the initial.
  const generation = useBotHostGeneration(hostId)
  useEffect(() => {
    if (!uploadKey) {
      return
    }
    // An away server can't answer, but a picture already loaded from it still shows.
    const pending = away
      ? loadedUploadRead({ hostId, id }, uploadKey)
      : uploadRead({ hostId, id }, uploadKey, generation)
    if (!pending) {
      return
    }
    let live = true
    void pending.then((read) => {
      if (live && read !== 'failed') {
        setUpload({ key: uploadKey, src: read.src })
      }
    })
    return () => {
      live = false
    }
  }, [hostId, id, uploadKey, away, generation])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}
