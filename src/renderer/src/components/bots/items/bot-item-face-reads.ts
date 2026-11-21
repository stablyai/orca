// What a long group's row faces read their pictures by: its rows mount as it scrolls, and each would
// read a picture again. `failures`: the latest failed read per bot while the group is shown, not read
// again until the group (or the panel) is reopened or the bot's host comes back. `live`: the hosts that
// can be called, read once for the group; a face on any other host doesn't read meanwhile.
import { createContext, useEffect, useMemo, useState } from 'react'
import { useLiveBotHostIds } from '@/lib/bot-host-views'
import type { BotAvatarFailures } from '../bot-avatar-image'

export type BotItemFaceReads = { failures: BotAvatarFailures; live: ReadonlySet<string> }

export const BotItemFaceReadsContext = createContext<BotItemFaceReads | null>(null)

/** A long group's reads for its faces; `enabled` while it windows rows that show faces. */
export function useBotItemFaceReads(enabled: boolean): BotItemFaceReads {
  const [failures] = useState((): BotAvatarFailures => new Map())
  const liveHosts = useLiveBotHostIds(enabled)
  const reads = useMemo(
    (): BotItemFaceReads => ({ failures, live: new Set(liveHosts) }),
    [failures, liveHosts]
  )
  // A host going away lets its bots' failed reads go, so coming back reads them again (at most 64).
  useEffect(() => {
    for (const key of failures.keys()) {
      if (!reads.live.has(key.slice(0, key.indexOf('\u0000')))) {
        failures.delete(key)
      }
    }
  }, [failures, reads])
  return reads
}
