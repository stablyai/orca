// A bot's chats, workers and runs stopped on their agent's usage limit, read from its host's status feed.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore
} from 'react'
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { useNow } from '@/lib/window-activity/use-now'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { hostUsageLimitStops, type HostUsageLimitStop } from './host-usage-limit-stops'

export type BotUsageLimitStop = HostUsageLimitStop

const NO_STOPS: readonly BotUsageLimitStop[] = []

/** The stopped sessions in these workspaces (the bot's home and its workers'), soonest first. */
export function useBotUsageLimitStops(
  bot: BotOnHost,
  workspaceIds: readonly string[]
): readonly BotUsageLimitStop[] {
  const target = botTarget(bot)
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  const hostStops = useMemo(() => hostUsageLimitStops(feed), [feed])
  useEffect(() => feed.activate(), [feed])
  const ids = useMemo(() => new Set(workspaceIds), [workspaceIds])
  // A minute clock retires a stop once its reset passes; it only re-renders.
  const now = useNow(60_000)
  // The host's stops are derived once for every reader; compare one string so a stop elsewhere
  // re-renders nothing.
  const read = useCallback(
    () => JSON.stringify(hostStops.stopsAt(now).filter((stop) => ids.has(stop.workspaceId))),
    [hostStops, ids, now]
  )
  const key = useSyncExternalStore(hostStops.subscribe, read)
  return useMemo(() => {
    const stops: BotUsageLimitStop[] = JSON.parse(key)
    return stops.length > 0 ? stops : NO_STOPS
  }, [key])
}

/** The Chats tab's stops: a chat by its session, a worker by its workspace. */
export type BotUsageLimitStopIndex = {
  bySession: ReadonlyMap<string, BotUsageLimitStop>
  byWorkspace: ReadonlyMap<string, BotUsageLimitStop>
}

const NO_INDEX: BotUsageLimitStopIndex = { bySession: new Map(), byWorkspace: new Map() }

export function indexUsageLimitStops(stops: readonly BotUsageLimitStop[]): BotUsageLimitStopIndex {
  if (stops.length === 0) {
    return NO_INDEX
  }
  // Soonest first, so a workspace with two stopped sessions shows the sooner one.
  const byWorkspace = new Map<string, BotUsageLimitStop>()
  for (const stop of stops) {
    if (!byWorkspace.has(stop.workspaceId)) {
      byWorkspace.set(stop.workspaceId, stop)
    }
  }
  return { bySession: new Map(stops.map((stop) => [stop.sessionId, stop])), byWorkspace }
}

export const BotUsageLimitStopsContext = createContext<BotUsageLimitStopIndex>(NO_INDEX)

export function useBotUsageLimitStopIndex(): BotUsageLimitStopIndex {
  return useContext(BotUsageLimitStopsContext)
}
