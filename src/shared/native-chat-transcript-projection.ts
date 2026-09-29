// The transcript's projection of a conversation's messages into the rows it draws:
// ordered, tool runs folded into the turn that made them, harness turns dropped.
// Shared so the host's conversation outline asks "which user messages draw a row?"
// of exactly what the renderer's transcript runs, not a second reading of it.

import type { NativeChatMessage } from './native-chat-types'
import { compareAgentJournalPositions } from './agent-session-journal-position'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages } from './native-chat-tool-fold'

/** Timestamp, then id. A null timestamp sorts first so a source that cannot supply
 *  one stays in place rather than jumping to the end. */
export function compareNativeChatMessagesByTime(
  a: NativeChatMessage,
  b: NativeChatMessage
): number {
  const at = a.timestamp ?? Number.NEGATIVE_INFINITY
  const bt = b.timestamp ?? Number.NEGATIVE_INFINITY
  if (at !== bt) {
    return at - bt
  }
  if (a.id < b.id) {
    return -1
  }
  if (a.id > b.id) {
    return 1
  }
  return 0
}

/** Rows the journal holds read in the journal's own order, never its clock: a
 *  batch shares one timestamp, and a row recovered after a crash carries an
 *  earlier one. A row not in the journal yet — a send still in the outbox — was
 *  made after everything the journal holds, so it follows them; only such rows,
 *  and terminal-backed transcripts, which have no journal, order by time. */
export function compareNativeChatTranscriptMessages(
  a: NativeChatMessage,
  b: NativeChatMessage
): number {
  if (a.journalPosition && b.journalPosition) {
    return compareAgentJournalPositions(a.journalPosition, b.journalPosition)
  }
  if (a.journalPosition || b.journalPosition) {
    return a.journalPosition ? -1 : 1
  }
  return compareNativeChatMessagesByTime(a, b)
}

/** `compare` lets the renderer order its own tail rows (streaming, optimistic
 *  sends), which never exist on the host. */
export function projectNativeChatTranscriptMessages(
  messages: readonly NativeChatMessage[],
  compare: (
    a: NativeChatMessage,
    b: NativeChatMessage
  ) => number = compareNativeChatTranscriptMessages
): NativeChatMessage[] {
  // Not `toSorted`: mobile's Hermes lacks it, and src/shared must stay loadable there.
  return stripNoiseMessages(foldToolMessages(Array.from(messages).sort(compare)))
}
