// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { createContext, useEffect, useMemo, useState } from 'react'
import { readBotAvatarPng } from '@/lib/bot-catalog'
import { botRefKey, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { botMascotSrc } from './bot-mascot-color'

// Each bot's current upload only (by botRefKey), so a replaced picture is let go; a failed read is retried next time.
const uploads = new Map<string, { version: string; src: Promise<string | null> }>()

function uploadSrc(bot: BotRef, version: string): Promise<string | null> {
  const key = botRefKey(bot)
  const cached = uploads.get(key)
  if (cached?.version === version) {
    return cached.src
  }
  const src = readBotAvatarPng(bot).then(
    (png) => (png ? `data:image/png;base64,${png}` : null),
    () => {
      uploads.delete(key)
      return null
    }
  )
  uploads.set(key, { version, src })
  return src
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
  useEffect(() => {
    if (!uploadKey) {
      return
    }
    let live = true
    void uploadSrc({ hostId, id }, uploadKey).then((src) => {
      if (live) {
        setUpload({ key: uploadKey, src })
      }
    })
    return () => {
      live = false
    }
  }, [hostId, id, uploadKey])
  if (mascotSrc) {
    return mascotSrc
  }
  return uploadKey && upload?.key === uploadKey ? upload.src : null
}

type AvatarBot = Pick<Bot, 'id' | 'avatar' | 'avatarColor'> & BotOnHost

/** Several bots' pictures, by botRefKey, read once for a list whose rows mount and unmount as it
 *  scrolls: a row drawn again shows its bot's picture at once, with no read of its own. */
export function useBotAvatarSrcs(bots: readonly AvatarBot[]): ReadonlyMap<string, string | null> {
  const mascots = useMemo(() => {
    const srcs = new Map<string, string | null>()
    for (const bot of bots) {
      const parsed = parseBotAvatar(bot.avatar)
      const src = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
      if (src || parsed?.kind !== 'upload') {
        srcs.set(botRefKey(bot), src)
      }
    }
    return srcs
  }, [bots])
  const [uploads, setUploads] = useState<ReadonlyMap<string, string | null>>(new Map())
  // A bot changing (a rename) rereads nothing: each upload's read is cached by its version.
  useEffect(() => {
    let live = true
    for (const bot of bots) {
      const parsed = parseBotAvatar(bot.avatar)
      const key = botRefKey(bot)
      if (parsed?.kind === 'upload' && !mascots.has(key)) {
        void uploadSrc({ hostId: bot.hostId, id: bot.id }, parsed.version).then((src) => {
          if (live) {
            setUploads((was) => (was.get(key) === src ? was : new Map(was).set(key, src)))
          }
        })
      }
    }
    return () => {
      live = false
    }
  }, [bots, mascots])
  return useMemo(() => new Map([...uploads, ...mascots]), [uploads, mascots])
}

/** A list's bots' pictures (from useBotAvatarSrcs), for its rows' faces; null outside such a list. */
export const BotAvatarSrcs = createContext<ReadonlyMap<string, string | null> | null>(null)
