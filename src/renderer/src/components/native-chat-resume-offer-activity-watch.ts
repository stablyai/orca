import {
  getStructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedOwner
} from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { NativeChatRestartOffer } from './native-chat-resume-on-restart-store'

/**
 * Re-reads the host once an offered or failed chat shows new activity, so a message the user sent
 * there, or its agent starting, retires its entry here too. The host stays the judge; this only
 * asks again.
 *
 * Held only while something is offered or failed. Keyed on status and prompt rather than every
 * summary, so an agent streaming in such a chat costs one re-read, not one per tool call.
 */
const OFFERED_CHAT_REFRESH_DELAY_MS = 500
let offeredChatWatch: {
  feed: StructuredAgentSessionStatusFeedOwner
  seen: Map<string, string>
  release: () => void
} | null = null
let offeredChatRefresh: ReturnType<typeof setTimeout> | null = null

function offeredChatIds(offer: NativeChatRestartOffer): Set<string> {
  return new Set([...offer.candidates, ...offer.failed].map((entry) => entry.sessionId))
}

function offeredChatActivityKey(summary: AgentSessionStatusSummary): string {
  return `${summary.status ?? ''}\u0000${summary.latestPrompt}`
}

export function syncNativeChatResumeOfferActivity(
  readOffer: () => NativeChatRestartOffer,
  refresh: () => void
): void {
  const offeredIds = offeredChatIds(readOffer())
  if (offeredIds.size === 0) {
    releaseNativeChatResumeOfferActivity()
    return
  }
  if (!offeredChatWatch) {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const unsubscribe = feed.subscribe(() => noticeOfferedChatActivity(readOffer, refresh))
    const deactivate = feed.activate()
    offeredChatWatch = {
      feed,
      seen: new Map(),
      release: () => {
        unsubscribe()
        deactivate()
      }
    }
  }
  const { feed, seen } = offeredChatWatch
  for (const sessionId of seen.keys()) {
    if (!offeredIds.has(sessionId)) {
      seen.delete(sessionId)
    }
  }
  // What the feed already holds is what this listing answered.
  for (const sessionId of offeredIds) {
    const summary = feed.getSnapshot().get(sessionId)
    if (summary && !seen.has(sessionId)) {
      seen.set(sessionId, offeredChatActivityKey(summary))
    }
  }
}

function noticeOfferedChatActivity(
  readOffer: () => NativeChatRestartOffer,
  refresh: () => void
): void {
  if (!offeredChatWatch) {
    return
  }
  const { feed, seen } = offeredChatWatch
  const snapshot = feed.getSnapshot()
  const offer = readOffer()
  let changed = false
  for (const sessionId of offeredChatIds(offer)) {
    const summary = snapshot.get(sessionId)
    if (!summary) {
      continue
    }
    const key = offeredChatActivityKey(summary)
    const previous = seen.get(sessionId)
    if (previous !== key) {
      seen.set(sessionId, key)
      // A first sighting is news only if newer than the list; a change to a known chat always is,
      // since the host may have answered the list just before the change was delivered here.
      changed ||= previous !== undefined || summary.updatedAt > offer.listedAt
    }
  }
  if (changed && offeredChatRefresh === null) {
    offeredChatRefresh = setTimeout(() => {
      offeredChatRefresh = null
      refresh()
    }, OFFERED_CHAT_REFRESH_DELAY_MS)
  }
}

export function releaseNativeChatResumeOfferActivity(): void {
  if (offeredChatRefresh !== null) {
    clearTimeout(offeredChatRefresh)
    offeredChatRefresh = null
  }
  offeredChatWatch?.release()
  offeredChatWatch = null
}
