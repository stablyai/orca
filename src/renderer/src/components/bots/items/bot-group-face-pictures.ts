// A group Items panel's member pictures for its row faces. Rows mount and unmount as a long list scrolls,
// so the panel, not each row, reads a member's uploaded picture: once per version, the first time a face of
// that member is drawn, kept while the panel is open. Nothing is read while the window is hidden or the
// member's host is offline; a failed read is tried again when its host comes back, or when the panel
// reopens.
import { createContext, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { readBotHostState, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'

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

export type BotGroupFacePictures = {
  /** A face of `bot` showing `version` is drawn; returns its leaving. */
  watch: (bot: BotRef, version: string, notify: () => void) => () => void
  /** The picture read for that version, or null while there is none. */
  read: (bot: BotRef, version: string) => string | null
}

export const BotGroupFacePicturesContext = createContext<BotGroupFacePictures | null>(null)

const hostOffline = (picture: Picture): boolean =>
  readBotHostState(picture.bot.hostId) === 'offline'

function createFacePictures(): BotGroupFacePictures {
  // One per member asked for, its latest version.
  const pictures = new Map<string, Picture>()
  // Pictures with faces still waiting on a read the window or host held up, or a failure.
  const waiting = new Set<Picture>()
  let stopWatching: (() => void) | null = null

  const syncWatching = (): void => {
    if (waiting.size > 0 && !stopWatching) {
      const stopHosts = subscribeToBotChanges(retryWaiting)
      const stopVisibility = subscribeWindowParkVisibility(retryWaiting)
      stopWatching = () => {
        stopHosts()
        stopVisibility()
      }
    } else if (waiting.size === 0 && stopWatching) {
      stopWatching()
      stopWatching = null
    }
  }

  const admit = (picture: Picture): void => {
    if (picture.src !== undefined || picture.reading || picture.faces.size === 0) {
      waiting.delete(picture)
      return
    }
    const offline = hostOffline(picture)
    if (picture.failed) {
      picture.hostLeft ||= offline
      if (!picture.hostLeft || offline) {
        waiting.add(picture)
        return
      }
    }
    if (offline || !getWindowParkVisible()) {
      waiting.add(picture)
      return
    }
    waiting.delete(picture)
    picture.reading = true
    picture.failed = false
    picture.hostLeft = false
    readBotAvatarPng(picture.bot).then(
      (png) => settle(picture, png ? `data:image/png;base64,${png}` : null),
      () => settle(picture, undefined)
    )
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
      if (picture.faces.size > 0) {
        waiting.add(picture)
      }
    } else {
      picture.src = src
    }
    syncWatching()
    picture.faces.forEach((notify) => notify())
  }

  function retryWaiting(): void {
    for (const picture of waiting) {
      admit(picture)
    }
    syncWatching()
  }

  return {
    watch: (bot, version, notify) => {
      const key = botRefKey(bot)
      let picture = pictures.get(key)
      if (picture?.version !== version) {
        if (picture) {
          waiting.delete(picture)
        }
        picture = {
          bot: { hostId: bot.hostId, id: bot.id },
          version,
          reading: false,
          failed: false,
          hostLeft: false,
          faces: new Set()
        }
        pictures.set(key, picture)
      }
      const current = picture
      current.faces.add(notify)
      admit(current)
      syncWatching()
      return () => {
        current.faces.delete(notify)
        if (current.faces.size === 0) {
          waiting.delete(current)
          syncWatching()
        }
      }
    },
    read: (bot, version) => {
      const picture = pictures.get(botRefKey(bot))
      return picture?.version === version ? (picture.src ?? null) : null
    }
  }
}

/** The panel's pictures, for as long as it is open: its faces leaving as it closes stop all watching. */
export function useBotGroupFacePictures(): BotGroupFacePictures {
  const [pictures] = useState(createFacePictures)
  return pictures
}
