// The failed picture reads of a group's row faces: the latest failed version per bot (at most 64).
// Rows in a long group mount as it scrolls, and each would read a failed picture again, so no row of a
// group does (one kind of face at every size, so a group growing or shrinking reads none again). Owned by
// the group, so reopening it (or the panel) reads them again, and a host going away lets its go.
import { createContext, useEffect, useState } from 'react'
import { isBotHostLive, subscribeToBotHostLive } from '@/lib/bot-host-views'
import {
  forgetBotAvatarFailures,
  watchBotAvatarFailureHosts,
  type BotAvatarFailures
} from '../bot-avatar-image'

export const BotItemFaceFailuresContext = createContext<BotAvatarFailures | null>(null)

/** A group's failures; `enabled` while its rows show faces. Each host with a failure is watched, and
 *  its going away lets that host's failures go. */
export function useBotItemFaceFailures(enabled: boolean): BotAvatarFailures {
  const [failures] = useState((): BotAvatarFailures => new Map())
  useEffect(() => {
    if (!enabled) {
      return
    }
    const stops = new Map<string, () => void>()
    const stopWatching = watchBotAvatarFailureHosts(failures, (hostId) => {
      if (stops.has(hostId)) {
        return
      }
      const stop = subscribeToBotHostLive(hostId, (wentAway) => {
        if (!wentAway && isBotHostLive(hostId)) {
          return
        }
        for (const [key, failure] of failures) {
          if (failure.hostId === hostId) {
            failures.delete(key)
          }
        }
      })
      stops.set(hostId, stop)
    })
    return () => {
      stopWatching()
      stops.forEach((stop) => stop())
      forgetBotAvatarFailures(failures)
    }
  }, [enabled, failures])
  return failures
}
