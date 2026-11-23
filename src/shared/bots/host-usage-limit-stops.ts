// One host's usage-limit stops, derived once per feed and refreshed only when a session's stop facts change.
import type { AgentSessionStatusSummary } from '../agent-session/agent-session-wire'
import type { AgentSessionStatusSnapshot } from '../agent-session/view/agent-session-status-snapshot-fold'
import { usageLimitStops, type NamedUsageLimitStop } from './bot-usage-limit-stop'

/** A host's status feed, the desktop's or the phone's. */
export type UsageLimitStopFeed = {
  getSnapshot: () => AgentSessionStatusSnapshot
  /** `change`: the sessions an update touched; null or absent when it doesn't say. */
  subscribe: (listener: (change?: ReadonlySet<string> | null) => void) => () => void
}

export type HostUsageLimitStop = NamedUsageLimitStop & { workspaceId: string }

type HostUsageLimitStops = {
  subscribe: (listener: () => void) => () => void
  /** Every stop the host lists at `now`, soonest first; the same array until a stop or `now` changes. */
  stopsAt: (now: number) => readonly HostUsageLimitStop[]
}

const indexes = new WeakMap<UsageLimitStopFeed, HostUsageLimitStops>()

/** The fields a stop reads; any other status change leaves every stop as it was. */
function sameStopFacts(
  a: AgentSessionStatusSummary | undefined,
  b: AgentSessionStatusSummary | undefined
): boolean {
  const cutA = a?.usageLimitContinue
  const cutB = b?.usageLimitContinue
  if (!cutA || !cutB) {
    return cutA === cutB
  }
  return (
    cutA.state === cutB.state &&
    cutA.resetsAt === cutB.resetsAt &&
    cutA.continueAt === cutB.continueAt &&
    a.workspaceId === b.workspaceId &&
    a.agent === b.agent &&
    a.conversationName === b.conversationName
  )
}

function createHostUsageLimitStops(feed: UsageLimitStopFeed): HostUsageLimitStops {
  // Only the sessions holding a usage-limit cut, so a reader's derive scales with stops, not sessions.
  let cut = new Map<string, AgentSessionStatusSummary>()
  let revision = 0
  let derived: { revision: number; now: number; stops: readonly HostUsageLimitStop[] } | null = null
  const listeners = new Set<() => void>()
  let stopFeed: (() => void) | null = null
  let readThisTask = false

  const readAll = (): Map<string, AgentSessionStatusSummary> => {
    const next = new Map<string, AgentSessionStatusSummary>()
    for (const summary of feed.getSnapshot().values()) {
      if (summary.usageLimitContinue) {
        next.set(summary.sessionId, summary)
      }
    }
    return next
  }
  const rebuild = (): boolean => {
    const next = readAll()
    const changed =
      next.size !== cut.size ||
      Array.from(next).some(([sessionId, summary]) => !sameStopFacts(cut.get(sessionId), summary))
    if (changed) {
      cut = next
      revision += 1
    }
    return changed
  }
  const onChange = (change?: ReadonlySet<string> | null): void => {
    let changed = false
    if (!change) {
      changed = rebuild()
    } else {
      const sessions = feed.getSnapshot()
      for (const sessionId of change) {
        const summary = sessions.get(sessionId)
        if (sameStopFacts(cut.get(sessionId), summary)) {
          continue
        }
        changed = true
        if (summary?.usageLimitContinue) {
          cut.set(sessionId, summary)
        } else {
          cut.delete(sessionId)
        }
      }
      if (changed) {
        revision += 1
      }
    }
    if (changed) {
      listeners.forEach((listener) => listener())
    }
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      if (!stopFeed) {
        stopFeed = feed.subscribe(onChange)
        rebuild()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopFeed?.()
          stopFeed = null
          readThisTask = false
          // Unwatched reads rebuild from the feed, so keep no summaries the feed has since replaced.
          cut = new Map()
          derived = null
        }
      }
    },
    stopsAt: (now) => {
      // Unwatched, nothing tells this index of changes, so it reads the feed afresh, once per task:
      // readers mounting together share one read, and the feed changes only between tasks.
      if (!stopFeed && !readThisTask) {
        readThisTask = true
        queueMicrotask(() => {
          readThisTask = false
        })
        rebuild()
      }
      if (derived?.revision !== revision || derived.now !== now) {
        derived = { revision, now, stops: usageLimitStops(cut, now) }
      }
      return derived.stops
    }
  }
}

export function hostUsageLimitStops(feed: UsageLimitStopFeed): HostUsageLimitStops {
  let index = indexes.get(feed)
  if (!index) {
    index = createHostUsageLimitStops(feed)
    indexes.set(feed, index)
  }
  return index
}
