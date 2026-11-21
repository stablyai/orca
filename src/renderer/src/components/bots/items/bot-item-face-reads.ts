// The failed picture reads of a group's row faces: the latest failed version per bot (at most 64).
// Rows in a long group mount as it scrolls, and each would read a failed picture again, so they don't;
// rows in a short group record failures too, so a group growing long doesn't read them again. Owned by
// the group, so reopening it (or the panel) reads them again, and a host going away lets its go.
import { createContext, useEffect, useState } from 'react'
import { isBotHostLive, subscribeToLiveBotHosts } from '@/lib/bot-host-views'
import { forgetBotAvatarFailures, type BotAvatarFailures } from '../bot-avatar-image'

export const BotItemFaceFailuresContext = createContext<BotAvatarFailures | null>(null)

/** A group's failures; `enabled` while its rows show faces. */
export function useBotItemFaceFailures(enabled: boolean): BotAvatarFailures {
  const [failures] = useState((): BotAvatarFailures => new Map())
  useEffect(() => {
    if (!enabled) {
      return
    }
    const stop = subscribeToLiveBotHosts(() => {
      for (const [key, failure] of failures) {
        if (!isBotHostLive(failure.hostId)) {
          failures.delete(key)
        }
      }
    })
    return () => {
      stop()
      forgetBotAvatarFailures(failures)
    }
  }, [enabled, failures])
  return failures
}
