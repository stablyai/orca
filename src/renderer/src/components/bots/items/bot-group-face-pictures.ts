// A group Items panel's member pictures for its row faces. Rows mount and unmount as a long list scrolls,
// so the panel, not each row, asks for a member's uploaded picture: once per version, the first time a
// face of that member is drawn, kept while the panel is open (through the shared picture cache, so a
// picture already read costs nothing). Nothing is asked while the window is hidden or the member's host
// is offline (asked once either comes back); a failed read is tried again on Back from an item or when
// the panel reopens.
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
import { parseBotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import { peekBotUploadSrc as readCachedBotUploadSrc, readBotUploadSrc } from '../bot-avatar-image'

type Picture = {
  bot: BotRef
  version: string
  /** The read's result: a data URL, or null for none. */
  src?: string | null
  reading: boolean
  failed: boolean
  /** The read failed and may be tried again (Back from an item) as a face draws. */
  retry: boolean
  faces: Set<() => void>
}

/** A face's view of one member's picture version, stable for the panel's life. */
export type BotGroupFacePicture = {
  subscribe: (notify: () => void) => () => void
  read: () => string | null
  /** The same picture for a face in a folded row: shows it if already read, asks for nothing. */
  folded?: BotGroupFacePicture
}

/** A face sits in a row folded out of view (Needs you keeps folded rows mounted). */
export const BotItemFaceFolded = createContext(false)

export type BotGroupFacePictures = {
  faceOf: (bot: BotRef, version: string) => BotGroupFacePicture
  /** The panel is shown: watch what waits. */
  open: () => void
  /** The panel closed: stop watching. */
  close: () => void
  /** The list shows again (Back from an item): failed pictures are read again as their faces draw. */
  retryFailed: () => void
  /** The group's members now: pictures of others, or of a version since replaced, with no face drawn
   *  are let go. */
  retain: (members: readonly (BotRef & Pick<Bot, 'avatar'>)[]) => void
}

export const BotGroupFacePicturesContext = createContext<BotGroupFacePictures | null>(null)

const hostOffline = (picture: Picture): boolean =>
  readBotHostState(picture.bot.hostId) === 'offline'

function createFacePictures(): BotGroupFacePictures {
  // One per member asked for, its latest version, and each face's handle on it.
  const pictures = new Map<string, Picture>()
  const handles = new Map<string, { version: string; handle: BotGroupFacePicture }>()
  // Pictures with a face drawn that wait on the window showing or their host's return; by host, with
  // whether that host was offline when last looked at.
  const waiting = new Map<BotRef['hostId'], { offline: boolean; pictures: Set<Picture> }>()
  let waitingCount = 0
  let stopWatching: (() => void) | null = null
  let liveHosts = readLiveBotHostIds()
  let closed = false
  let retained: readonly (BotRef & Pick<Bot, 'avatar'>)[] = []

  const wait = (picture: Picture, offline: boolean): void => {
    const host = waiting.get(picture.bot.hostId) ?? { offline, pictures: new Set<Picture>() }
    waiting.set(picture.bot.hostId, host)
    if (!host.pictures.has(picture)) {
      host.pictures.add(picture)
      waitingCount += 1
    }
  }
  const unwait = (picture: Picture): void => {
    const host = waiting.get(picture.bot.hostId)
    if (host?.pictures.delete(picture)) {
      waitingCount -= 1
      if (host.pictures.size === 0) {
        waiting.delete(picture.bot.hostId)
      }
    }
  }
  const eachWaiting = (visit: (picture: Picture) => void): void => {
    for (const host of waiting.values()) {
      host.pictures.forEach(visit)
    }
  }

  const syncWatching = (): void => {
    if (waitingCount > 0 && !stopWatching && !closed) {
      liveHosts = readLiveBotHostIds()
      const stopHosts = subscribeToBotChanges(onHosts)
      const stopVisibility = subscribeWindowParkVisibility(onVisibility)
      stopWatching = () => {
        stopHosts()
        stopVisibility()
      }
    } else if ((waitingCount === 0 || closed) && stopWatching) {
      stopWatching()
      stopWatching = null
    }
  }

  // Only pictures with a face drawn wait; one without is looked at again as a face returns.
  const admit = (picture: Picture): void => {
    if (picture.src !== undefined || picture.reading || picture.faces.size === 0) {
      unwait(picture)
      return
    }
    // A picture the shared cache already holds shows even while the host can't be asked.
    const cached = readCachedBotUploadSrc(picture.bot, picture.version)
    if (cached !== undefined) {
      unwait(picture)
      picture.src = cached
      picture.failed = false
      picture.faces.forEach((notify) => notify())
      return
    }
    if (picture.failed && !picture.retry) {
      unwait(picture)
      return
    }
    const offline = hostOffline(picture)
    if (offline || !getWindowParkVisible()) {
      wait(picture, offline)
      return
    }
    unwait(picture)
    picture.reading = true
    picture.failed = false
    picture.retry = false
    void readBotUploadSrc(picture.bot, picture.version).then((src) => settle(picture, src))
  }

  const settle = (picture: Picture, src: string | null | undefined): void => {
    picture.reading = false
    // A reply for a version since replaced is dropped.
    if (pictures.get(botRefKey(picture.bot)) === picture) {
      if (src === undefined) {
        picture.failed = true
      } else {
        picture.src = src
      }
      picture.faces.forEach((notify) => notify())
    }
    syncWatching()
  }

  // Only a host coming or going matters, and only to the pictures waiting on that host.
  function onHosts(): void {
    const now = readLiveBotHostIds()
    if (now === liveHosts) {
      return
    }
    liveHosts = now
    for (const [hostId, host] of waiting) {
      const offline = readBotHostState(hostId) === 'offline'
      if (offline !== host.offline) {
        host.offline = offline
        host.pictures.forEach(admit)
      }
    }
    syncWatching()
  }

  function onVisibility(): void {
    if (!getWindowParkVisible()) {
      return
    }
    eachWaiting(admit)
    syncWatching()
  }

  const pictureOf = (bot: BotRef, version: string): Picture => {
    const key = botRefKey(bot)
    const found = pictures.get(key)
    if (found?.version === version) {
      return found
    }
    if (found) {
      unwait(found)
    }
    const picture: Picture = {
      bot: { hostId: bot.hostId, id: bot.id },
      version,
      reading: false,
      failed: false,
      retry: false,
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
    retryFailed: () => {
      for (const picture of pictures.values()) {
        picture.retry ||= picture.failed
      }
    },
    retain: (bots) => {
      // A group refresh that changes no member or picture hands the same bots again.
      const same =
        bots.length === retained.length && bots.every((bot, index) => bot === retained[index])
      retained = bots
      if (same || (handles.size === 0 && pictures.size === 0)) {
        return
      }
      const members = new Map(
        bots.map((bot) => {
          const avatar = parseBotAvatar(bot.avatar)
          return [botRefKey(bot), avatar?.kind === 'upload' ? avatar.version : null]
        })
      )
      // A folded face's handle has no picture behind it; one for a bot no longer shown at that version goes.
      for (const [key, known] of handles) {
        if (members.get(key) !== known.version && !pictures.get(key)?.faces.size) {
          handles.delete(key)
        }
      }
      for (const [key, picture] of pictures) {
        if (members.get(key) !== picture.version && picture.faces.size === 0) {
          pictures.delete(key)
          handles.delete(key)
          unwait(picture)
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
      handle.folded = { subscribe: () => () => {}, read: handle.read }
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
