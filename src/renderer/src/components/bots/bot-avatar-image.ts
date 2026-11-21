// Where a bot's picture loads from: a bundled mascot, or its uploaded PNG read once per version.
import { useCallback, useEffect, useMemo, useState } from 'react'
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

/** Each of `bots`' picture URLs, uploads read once per version while the caller is mounted, so faces that
 *  mount as a list scrolls read nothing themselves. Undefined for a bot not among `bots`. */
export function useBotAvatarSrcs(
  bots: readonly AvatarBot[]
): (bot: AvatarBot) => string | null | undefined {
  const signature = JSON.stringify(
    bots.flatMap((bot) => {
      const parsed = parseBotAvatar(bot.avatar)
      return parsed?.kind === 'upload' ? [[bot.hostId, bot.id, parsed.version]] : []
    })
  )
  const wanted = useMemo(
    () =>
      (JSON.parse(signature) as [BotRef['hostId'], string, string][]).map(
        ([hostId, id, version]) => ({
          ref: { hostId, id },
          key: `${botRefKey({ hostId, id })}@${version}`,
          version
        })
      ),
    [signature]
  )
  const [read, setRead] = useState<ReadonlyMap<string, string | null>>(() => new Map())
  useEffect(() => {
    let live = true
    for (const { ref, key, version } of wanted) {
      void uploadSrc(ref, version).then((src) => {
        if (!live) {
          return
        }
        // Only the current versions are kept, so a long-open panel holds one picture per bot.
        setRead((prev) => {
          const next = new Map<string, string | null>()
          for (const other of wanted) {
            if (prev.has(other.key)) {
              next.set(other.key, prev.get(other.key)!)
            }
          }
          return next.set(key, src)
        })
      })
    }
    return () => {
      live = false
    }
  }, [wanted])
  return useCallback(
    (bot: AvatarBot) => {
      const parsed = parseBotAvatar(bot.avatar)
      const mascotSrc = botMascotSrc(parsed?.kind === 'mascot' ? parsed.id : null, bot.avatarColor)
      if (mascotSrc) {
        return mascotSrc
      }
      if (parsed?.kind !== 'upload') {
        return null
      }
      const key = `${botRefKey(bot)}@${parsed.version}`
      return wanted.some((entry) => entry.key === key) ? (read.get(key) ?? null) : undefined
    },
    [wanted, read]
  )
}
