// A group Items panel's member pictures that have no image (their read failed or came back empty) start
// over when their host comes back, by its listing or only its event stream, and take a picture as soon
// as another view reads it into the shared cache, so a row never keeps an initial beside a shown picture.
import { botHostGeneration, onBotHostCameBack } from '@/lib/bot-host-link-read'
import type { BotRef } from '@/lib/bot-hosts'
import { peekBotUploadSrc, subscribeToBotUploadLoads } from '../bot-avatar-image'

/** One member's picture version in a panel (bot-group-face-pictures.ts). */
export type FacePicture = {
  bot: BotRef
  version: string
  /** The read's result: a data URL, or null for none. */
  src?: string | null
  reading: boolean
  /** Counts reads started; a reply from one since superseded is dropped. */
  attempt: number
  /** The host's coming-back the latest read was started in (botHostGeneration). */
  generation?: number
  failed: boolean
  /** The read failed and may be tried again (Back from an item) as a face draws. */
  retry: boolean
  faces: Set<() => void>
}

/** A read starts for the picture: returns its attempt, for settlement to check it is still current. */
export function startFacePictureRead(picture: FacePicture): number {
  picture.generation = botHostGeneration(picture.bot.hostId)
  picture.attempt += 1
  return picture.attempt
}

/** Lets a picture with no image start over: a read still out from before is dropped. */
function forget(picture: FacePicture): void {
  if (picture.reading) {
    picture.attempt += 1
    picture.reading = false
  }
  picture.src = undefined
  picture.failed = false
  picture.retry = false
}

/** Watches for a reason to ask again for the panel's pictures without an image; returns the stop. */
export function watchFacePictureRecovery(
  pictures: ReadonlyMap<string, FacePicture>,
  admit: (picture: FacePicture) => void,
  syncWatching: () => void
): () => void {
  const stopLoads = subscribeToBotUploadLoads((key) => {
    const picture = pictures.get(key)
    if (
      picture &&
      typeof picture.src !== 'string' &&
      typeof peekBotUploadSrc(picture.bot, picture.version) === 'string'
    ) {
      forget(picture)
      admit(picture)
      syncWatching()
    }
  })
  // What the host answered before, or failed to, says nothing once it is back. A read already started
  // in this return (as the listing published it live) is of now, so it is kept.
  const stopCameBack = onBotHostCameBack((hostId) => {
    const now = botHostGeneration(hostId)
    for (const picture of pictures.values()) {
      if (
        picture.bot.hostId === hostId &&
        typeof picture.src !== 'string' &&
        picture.generation !== now
      ) {
        forget(picture)
        admit(picture)
      }
    }
    syncWatching()
  })
  return () => {
    stopLoads()
    stopCameBack()
  }
}
