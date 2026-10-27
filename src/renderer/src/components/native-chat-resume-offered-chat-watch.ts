import type { StructuredAgentSessionStatusFeedOwner } from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

/** Watch offered/failed chats only; debounce status/prompt changes into host rereads without one request per streamed summary. */

const OFFERED_CHAT_REFRESH_DELAY_MS = 500

function activityKey(summary: AgentSessionStatusSummary): string {
  return `${summary.status ?? ''}\u0000${summary.latestPrompt}`
}

export function createOfferedChatWatch(deps: {
  feed: () => StructuredAgentSessionStatusFeedOwner
  offeredIds: () => Set<string>
  /** When the list being watched arrived; a first sighting older than it is not news. */
  listedAt: () => number
  refresh: () => void
}): { sync: () => void; release: () => void } {
  let watch: {
    feed: StructuredAgentSessionStatusFeedOwner
    seen: Map<string, string>
    release: () => void
  } | null = null
  let pendingRefresh: ReturnType<typeof setTimeout> | null = null

  const notice = (): void => {
    if (!watch) {
      return
    }
    const { feed, seen } = watch
    const snapshot = feed.getSnapshot()
    let changed = false
    for (const sessionId of deps.offeredIds()) {
      const summary = snapshot.get(sessionId)
      if (!summary) {
        continue
      }
      const key = activityKey(summary)
      const previous = seen.get(sessionId)
      if (previous !== key) {
        seen.set(sessionId, key)
        // A first sighting must postdate the list; known changes count even when host timestamps or delivery order disagree.
        changed ||= previous !== undefined || summary.updatedAt > deps.listedAt()
      }
    }
    if (changed && pendingRefresh === null) {
      pendingRefresh = setTimeout(() => {
        pendingRefresh = null
        deps.refresh()
      }, OFFERED_CHAT_REFRESH_DELAY_MS)
    }
  }

  const release = (): void => {
    if (pendingRefresh !== null) {
      clearTimeout(pendingRefresh)
      pendingRefresh = null
    }
    watch?.release()
    watch = null
  }

  const sync = (): void => {
    const offeredIds = deps.offeredIds()
    if (offeredIds.size === 0) {
      release()
      return
    }
    if (!watch) {
      const feed = deps.feed()
      const unsubscribe = feed.subscribe(notice)
      const deactivate = feed.activate()
      watch = {
        feed,
        seen: new Map(),
        release: () => {
          unsubscribe()
          deactivate()
        }
      }
    }
    const { feed, seen } = watch
    for (const sessionId of seen.keys()) {
      if (!offeredIds.has(sessionId)) {
        seen.delete(sessionId)
      }
    }
    // What the feed already holds is what this listing answered.
    for (const sessionId of offeredIds) {
      const summary = feed.getSnapshot().get(sessionId)
      if (summary && !seen.has(sessionId)) {
        seen.set(sessionId, activityKey(summary))
      }
    }
  }

  return { sync, release }
}
