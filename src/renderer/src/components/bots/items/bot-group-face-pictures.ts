// A group Items panel's member pictures for its row faces. Rows mount and unmount as a long list scrolls,
// so the panel, not each row, asks for a member's uploaded picture: once per version, the first time a
// face of that member is drawn, kept while the panel is open (through the shared picture cache, so a
// picture already read costs nothing). Nothing is asked while the window is hidden or the member's host
// is offline; a failed read is tried again when its host comes back, or when the panel reopens.
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
import { readBotUploadSrc } from '../bot-avatar-image'

type Picture = {
  bot: BotRef
  version: string
  /** The read's result: a data URL, or null for none. */
  src?: string | null
  reading: boolean
  failed: boolean
  /** The host was offline since the read failed, so its coming back reads again. */
  hostLeft: boolean
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
}

export const BotGroupFacePicturesContext = createContext<BotGroupFacePictures | null>(null)

const hostOffline = (picture: Picture): boolean =>
  readBotHostState(picture.bot.hostId) === 'offline'

function createFacePictures(): BotGroupFacePictures {
  // One per member asked for, its latest version, and each face's handle on it.
  const pictures = new Map<string, Picture>()
  const handles = new Map<string, { version: string; handle: BotGroupFacePicture }>()
  // Pictures that wait on the window showing, their host, or (failed) their host leaving and coming back.
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

  const admit = (picture: Picture): void => {
    if (picture.src !== undefined || picture.reading) {
      waiting.delete(picture)
      return
    }
    // A failure stays watched without faces, so its host leaving is seen; other waits need a face.
    if (picture.failed && !picture.hostLeft) {
      waiting.add(picture)
      return
    }
    if (picture.faces.size === 0) {
      if (!picture.failed) {
        waiting.delete(picture)
      }
      return
    }
    if (hostOffline(picture) || !getWindowParkVisible()) {
      waiting.add(picture)
      return
    }
    waiting.delete(picture)
    picture.reading = true
    picture.failed = false
    picture.hostLeft = false
    void readBotUploadSrc(picture.bot, picture.version).then((src) => settle(picture, src))
  }

  const settle = (picture: Picture, src: string | null | undefined): void => {
    picture.reading = false
    // A reply for a version since replaced is dropped.
    if (pictures.get(botRefKey(picture.bot)) !== picture) {
      return
    }
    if (src === undefined) {
      picture.failed = true
      picture.hostLeft = hostOffline(picture)
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
      if (picture.failed && hostOffline(picture)) {
        picture.hostLeft = true
      } else {
        admit(picture)
      }
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
      failed: false,
      hostLeft: false,
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
