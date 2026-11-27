// Access requests you can still answer. A request is a to-do: it stays until it is decided or expires, and an
// expiry takes it away on time, not at the next unrelated change.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { readBots, readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { useAccessRequests, type HostAccessRequest } from '@/lib/bot-access-requests'
import { isLiveAccessRequest, nextAccessRequestExpiry } from './activity-inbox'

// setTimeout fires at once past this; a farther expiry re-checks then and waits again.
const MAX_TIMER_MS = 2 ** 31 - 1

export function useLiveAccessRequests(): readonly HostAccessRequest[] {
  const all = useAccessRequests()
  // Whether a request is live reads its host's state and the bot list, so re-check when either changes.
  const allBots = useSyncExternalStore(subscribeToBotChanges, readBots)
  const liveHosts = useSyncExternalStore(subscribeToBotChanges, readLiveBotHostIds)
  const [expiryTick, setExpiryTick] = useState(0)
  const live = useMemo(
    () => all.filter((request) => isLiveAccessRequest(request)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- allBots, liveHosts and expiryTick are what the check reads.
    [all, allBots, liveHosts, expiryTick]
  )
  useEffect(() => {
    const now = Date.now()
    const next = nextAccessRequestExpiry(live, now)
    if (next === null) {
      return
    }
    const timer = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.min(next - now, MAX_TIMER_MS)
    )
    return () => clearTimeout(timer)
  }, [live])
  return live
}
