// A group Items panel's member pictures for its row faces. Rows mount and unmount as a long list scrolls,
// so the panel, not each row, asks for a member's uploaded picture: once per version, the first time a
// face of that member is drawn, kept while the panel is open (through the shared picture cache, so a
// picture already read costs nothing). Nothing is asked while the window is hidden or the member's host
// is offline; a failed read is tried again once a host comes or goes (its own coming back included), as
// a face of it is drawn, or when the panel reopens.
import { createContext, useEffect, useState } from 'react'
import {
  readBotHostState,
  readLiveBotHostIds,
  subscribeToBotChanges
} from '@/lib/bot-catalog-snapshot'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'
import { peekBotUploadSrc as readCachedBotUploadSrc, readBotUploadSrc } from '../bot-avatar-image'

type Picture = {
  bot: BotRef
  version: string
  /** The read's result: a data URL, or null for none. */
  src?: string | null
  reading: boolean
  /** The read failed while these hosts were live: it is tried again once a host comes or goes. */
  failedWith: ReturnType<typeof readLiveBotHostIds> | null
  faces: Set<() => void>
}

/** A face's view of one member's picture version, stable for the panel's life. */
export type BotGroupFacePicture = {
  subscribe: (notify: () => void) => () => void
  read: () => string | null
}

export type BotGroupFacePictures = {
  faceOf: (bot: BotRef, version: string) => BotGroupFacePicture
  /** The panel is shown: watch what waits. */
  open: () => void
  /** The panel closed: stop watching. */
  close: () => void
  /** The group's members now (botRefKey to upload version, null for none): pictures of others, or of
   *  a version since replaced, with no face drawn are let go. */
  retain: (members: ReadonlyMap<string, string | null>) => void
}

export const BotGroupFacePicturesContext = createContext<BotGroupFacePictures | null>(null)

const hostOffline = (picture: Picture): boolean =>
  readBotHostState(picture.bot.hostId) === 'offline'

function createFacePictures(): BotGroupFacePictures {
  // One per member asked for, its latest version, and each face's handle on it.
  const pictures = new Map<string, Picture>()
  const handles = new Map<string, { version: string; handle: BotGroupFacePicture }>()
  // Pictures with a face drawn that wait on the window showing, their host, or (failed) a host coming or going.
  const waiting = new Set<Picture>()
  let stopWatching: (() => void) | null = null
  let liveHosts = readLiveBotHostIds()
  let closed = false

  const syncWatching = (): void => {
    if (waiting.size > 0 && !stopWatching && !closed) {
      liveHosts = readLiveBotHostIds()
      const stopHosts = subscribeToBotChanges(onHosts)
      const stopVisibility = subscribeWindowParkVisibility(onVisibility)
      stopWatching = () => {
        stopHosts()
        stopVisibility()
      }
    } else if ((waiting.size === 0 || closed) && stopWatching) {
      stopWatching()
      stopWatching = null
    }
  }

  // Only pictures with a face drawn wait; one without is looked at again as a face returns.
  const admit = (picture: Picture): void => {
    if (picture.src !== undefined || picture.reading || picture.faces.size === 0) {
      waiting.delete(picture)
      return
    }
    // A picture the shared cache already holds shows even while the host can't be asked.
    const cached = readCachedBotUploadSrc(picture.bot, picture.version)
    if (cached !== undefined) {
      waiting.delete(picture)
      picture.src = cached
      picture.failedWith = null
      picture.faces.forEach((notify) => notify())
      return
    }
    if (
      picture.failedWith === readLiveBotHostIds() ||
      hostOffline(picture) ||
      !getWindowParkVisible()
    ) {
      waiting.add(picture)
      return
    }
    waiting.delete(picture)
    picture.reading = true
    picture.failedWith = null
    void readBotUploadSrc(picture.bot, picture.version).then((src) => settle(picture, src))
  }

  const settle = (picture: Picture, src: string | null | undefined): void => {
    picture.reading = false
    // A reply for a version since replaced is dropped.
    if (pictures.get(botRefKey(picture.bot)) !== picture) {
      return
    }
    if (src === undefined) {
      picture.failedWith = readLiveBotHostIds()
      admit(picture)
    } else {
      picture.src = src
    }
    syncWatching()
    picture.faces.forEach((notify) => notify())
  }

  // Only a host coming or going matters; other catalog changes keep the same live list.
  function onHosts(): void {
    const now = readLiveBotHostIds()
    if (now === liveHosts) {
      return
    }
    liveHosts = now
    for (const picture of waiting) {
      admit(picture)
    }
    syncWatching()
  }

  function onVisibility(): void {
    if (!getWindowParkVisible()) {
      return
    }
    for (const picture of waiting) {
      admit(picture)
    }
    syncWatching()
  }

  const pictureOf = (bot: BotRef, version: string): Picture => {
    const key = botRefKey(bot)
    const found = pictures.get(key)
    if (found?.version === version) {
      return found
    }
    if (found) {
      waiting.delete(found)
    }
    const picture: Picture = {
      bot: { hostId: bot.hostId, id: bot.id },
      version,
      reading: false,
      failedWith: null,
      faces: new Set()
    }
    pictures.set(key, picture)
    return picture
  }

  return {
    open: () => {
      closed = false
      syncWatching()
    },
    close: () => {
      closed = true
      syncWatching()
    },
    retain: (members) => {
      for (const [key, picture] of pictures) {
        if (members.get(key) !== picture.version && picture.faces.size === 0) {
          pictures.delete(key)
          handles.delete(key)
          waiting.delete(picture)
        }
      }
      syncWatching()
    },
    faceOf: (bot, version) => {
      const key = botRefKey(bot)
      const known = handles.get(key)
      if (known?.version === version) {
        return known.handle
      }
      const ref = { hostId: bot.hostId, id: bot.id }
      const handle: BotGroupFacePicture = {
        subscribe: (notify) => {
          const picture = pictureOf(ref, version)
          picture.faces.add(notify)
          admit(picture)
          syncWatching()
          return () => {
            picture.faces.delete(notify)
            if (picture.faces.size === 0) {
              admit(picture)
              syncWatching()
            }
          }
        },
        read: () => {
          const picture = pictures.get(key)
          return picture?.version === version ? (picture.src ?? null) : null
        }
      }
      handles.set(key, { version, handle })
      return handle
    }
  }
}

/** The panel's pictures, for as long as it is open. */
export function useBotGroupFacePictures(): BotGroupFacePictures {
  const [pictures] = useState(createFacePictures)
  useEffect(() => {
    pictures.open()
    return pictures.close
  }, [pictures])
  return pictures
}
