import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

/** How a watched message left its chat's outbox: sent on (accepted, or handed to the host or the
 *  composer), or thrown away with the chat. */
export type StructuredAgentSessionOutboxEntryRemoval = 'spent' | 'discarded'

type EntryWatch = {
  entry: StructuredAgentSessionOutboxEntry
  onGone: (removal: StructuredAgentSessionOutboxEntryRemoval) => void
}

const watchesBySession = new Map<string, Set<EntryWatch>>()

// A user's Retry of a refused message gives it a new id; its text and queue time stay.
function stillQueued(
  watched: StructuredAgentSessionOutboxEntry,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  const body = JSON.stringify(watched.body)
  return entries.some(
    (entry) =>
      entry.clientMessageId === watched.clientMessageId ||
      (entry.queuedAt === watched.queuedAt && JSON.stringify(entry.body) === body)
  )
}

/** Calls `onGone` once, when `entry` leaves its session's outbox. */
export function watchStructuredAgentSessionOutboxEntry(
  entry: StructuredAgentSessionOutboxEntry,
  onGone: (removal: StructuredAgentSessionOutboxEntryRemoval) => void
): () => void {
  const watches = watchesBySession.get(entry.sessionId) ?? new Set()
  watchesBySession.set(entry.sessionId, watches)
  const watch: EntryWatch = { entry, onGone }
  watches.add(watch)
  return () => {
    watches.delete(watch)
    if (watches.size === 0 && watchesBySession.get(entry.sessionId) === watches) {
      watchesBySession.delete(entry.sessionId)
    }
  }
}

/** Run by the outbox's one write funnel after a change takes effect. */
export function settleStructuredAgentSessionOutboxEntryWatches(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[],
  removal: StructuredAgentSessionOutboxEntryRemoval
): void {
  const watches = watchesBySession.get(sessionId)
  if (!watches) {
    return
  }
  for (const watch of watches) {
    if (!stillQueued(watch.entry, entries)) {
      watches.delete(watch)
      watch.onGone(removal)
    }
  }
  if (watches.size === 0) {
    watchesBySession.delete(sessionId)
  }
}
