// Tells a source that handed a chat its review reply when that chat's host has written it: the
// receipt (a failure line or a tombstone) reaching this client in the chat's live read. The checks panel
// refetches the PR then, which matters where the chat's host is a paired server whose own
// mutation notice never reaches this client.

import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  AGENT_SESSION_REVIEW_REPLY_WINDOW_MS,
  isAgentSessionReviewReplyReceiptKey
} from '../../../shared/agent-session-review-reply'

type Watcher = { run: () => void; dispose: () => void }

const watchers = new Map<string, Set<Watcher>>()

function forget(sessionId: string, watcher: Watcher): void {
  const set = watchers.get(sessionId)
  set?.delete(watcher)
  if (set?.size === 0) {
    watchers.delete(sessionId)
  }
}

/**
 * Runs `onSettled` once, the first time a receipt reaches this chat's live stream. `holdRead` keeps
 * that stream open while the watch is armed, as owed work does, so a hidden chat still hears it.
 * The watch, and its hold, die on its run, on the returned dispose, when the chat closes, or after
 * the window in which the host still owes the reply.
 */
export function watchStructuredReviewReplySettled(
  sessionId: string,
  onSettled: () => void,
  options: { holdRead?: () => () => void; lifetimeMs?: number } = {}
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let releaseRead: (() => void) | undefined
  const watcher: Watcher = {
    run: () => {
      watcher.dispose()
      onSettled()
    },
    dispose: () => {
      clearTimeout(timer)
      releaseRead?.()
      releaseRead = undefined
      forget(sessionId, watcher)
    }
  }
  timer = setTimeout(watcher.dispose, options.lifetimeMs ?? AGENT_SESSION_REVIEW_REPLY_WINDOW_MS)
  const set = watchers.get(sessionId) ?? new Set()
  set.add(watcher)
  watchers.set(sessionId, set)
  releaseRead = options.holdRead?.()
  return watcher.dispose
}

/** The chat closed: nothing it would have said is coming. */
export function dropStructuredReviewReplyWatchers(sessionId: string): void {
  for (const watcher of Array.from(watchers.get(sessionId) ?? [])) {
    watcher.dispose()
  }
}

/** Called with each live event of a chat's stream; a snapshot is history, not news. */
export function noticeStructuredReviewReplyReceipt(
  sessionId: string,
  event: AgentSessionSubscribeEvent
): void {
  if (!watchers.has(sessionId) || event.type !== 'batch') {
    return
  }
  const touched =
    event.batch.items.some((item) => isAgentSessionReviewReplyReceiptKey(item.itemId)) ||
    event.batch.removedItemIds.some(isAgentSessionReviewReplyReceiptKey)
  if (touched) {
    for (const watcher of Array.from(watchers.get(sessionId) ?? [])) {
      watcher.run()
    }
  }
}
