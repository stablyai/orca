// The transcript's projection of a conversation's messages into the rows it draws:
// ordered, tool runs folded into the turn that made them, harness turns dropped.
// Shared so the host's conversation outline asks "which user messages draw a row?"
// of exactly what the renderer's transcript runs, not a second reading of it.
//
// A session's subagents write into its journal, but their rows are not part of its
// conversation: each subagent's rows are that subagent's, kept apart and folded on
// their own, for the surface that shows them beside the spawn that ran it.

import { nativeChatSemanticRowId, type NativeChatMessage } from './native-chat-types'
import { compareAgentJournalPositions } from './agent-session-journal-position'
import { agentJournalItemSubagentId } from './agent-session-journal-producer'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages } from './native-chat-tool-fold'
import { nativeChatTurnMembership, type NativeChatTurnJournal } from './native-chat-turn-membership'

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
  // Split reasoning shares its provider row's key, before that row's answer.
  const aId = nativeChatSemanticRowId(a)
  const bId = nativeChatSemanticRowId(b)
  const aReasoning = aId !== a.id
  const bReasoning = bId !== b.id
  if (aId < bId) {
    return -1
  }
  if (aId > bId) {
    return 1
  }
  return Number(bReasoning) - Number(aReasoning)
}

/** Rows the journal holds read in the journal's own order, never its clock: a
 *  batch shares one timestamp, and a row recovered after a crash carries an
 *  earlier one. A row not in the journal yet — a send still on its way — was
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
  if (
    a.transcriptOrder !== undefined &&
    b.transcriptOrder !== undefined &&
    a.transcriptOrder !== b.transcriptOrder
  ) {
    return a.transcriptOrder - b.transcriptOrder
  }
  if ((a.transcriptOrder === undefined) !== (b.transcriptOrder === undefined)) {
    return a.transcriptOrder === undefined ? 1 : -1
  }
  return compareNativeChatMessagesByTime(a, b)
}

type NativeChatMessageCompare = (a: NativeChatMessage, b: NativeChatMessage) => number

/** One of a subagent's rows, with the conversation turn it happened during. */
export type NativeChatSubagentRow = {
  message: NativeChatMessage
  turnKey: string | undefined
}

export type NativeChatTranscriptProjection = {
  /** The session's own agent's rows. */
  conversation: NativeChatMessage[]
  /** Each subagent's own rows, in order, by the id they carry. */
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
}

const NO_SUBAGENT_ROWS: ReadonlyMap<string, readonly NativeChatSubagentRow[]> = new Map()

function projectRows(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  return stripNoiseMessages(foldToolMessages(messages))
}

function sortedCopy(
  messages: readonly NativeChatMessage[],
  compare: NativeChatMessageCompare
): NativeChatMessage[] {
  // Not `toSorted`: mobile's Hermes lacks it, and src/shared must stay loadable there.
  return Array.from(messages).sort(compare)
}

/** The conversation alone. `compare` lets the renderer order its own tail rows
 *  (streaming, optimistic sends), which never exist on the host. */
export function projectNativeChatTranscriptMessages(
  messages: readonly NativeChatMessage[],
  compare: NativeChatMessageCompare = compareNativeChatTranscriptMessages
): NativeChatMessage[] {
  return projectNativeChatTranscript(messages, compare).conversation
}

/** `journal`: what places the conversation's rows in their turns
 *  (`nativeChatTurnMembership`), so a subagent's row sits in the turn a parent row there would. */
export function projectNativeChatTranscript(
  messages: readonly NativeChatMessage[],
  compare: NativeChatMessageCompare = compareNativeChatTranscriptMessages,
  journal?: NativeChatTurnJournal | null
): NativeChatTranscriptProjection {
  const sorted = sortedCopy(messages, compare)
  const own: NativeChatMessage[] = []
  const byAgent = new Map<string, NativeChatMessage[]>()
  for (const message of sorted) {
    const agentId = agentJournalItemSubagentId(message)
    if (agentId === null) {
      own.push(message)
    } else {
      const rows = byAgent.get(agentId)
      if (rows) {
        rows.push(message)
      } else {
        byAgent.set(agentId, [message])
      }
    }
  }
  const conversation = projectRows(own)
  if (byAgent.size === 0) {
    return { conversation, subagentRows: NO_SUBAGENT_ROWS }
  }
  // Only a user row the conversation draws opens a turn by position, never a subagent's.
  const turnStarts = new Set(
    conversation.filter((message) => message.role === 'user').map((message) => message.id)
  )
  const { turnKeys } = nativeChatTurnMembership(sorted, journal, (message) =>
    turnStarts.has(message.id)
  )
  const turnOf = new Map(sorted.map((message, index) => [message, turnKeys[index]]))
  const subagentRows = new Map<string, NativeChatSubagentRow[]>()
  for (const [agentId, rows] of byAgent) {
    // Folded one parent turn at a time: a run the subagent carries across a turn
    // boundary splits there, so each of its edits counts in the turn it was made.
    const projected: NativeChatSubagentRow[] = []
    let chunk: NativeChatMessage[] = []
    let chunkTurn: string | undefined
    const flush = (): void => {
      for (const message of projectRows(chunk)) {
        projected.push({ message, turnKey: chunkTurn })
      }
      chunk = []
    }
    for (const message of rows) {
      const turn = turnOf.get(message)
      if (chunk.length > 0 && turn !== chunkTurn) {
        flush()
      }
      chunkTurn = turn
      chunk.push(message)
    }
    flush()
    subagentRows.set(agentId, projected)
  }
  return { conversation, subagentRows }
}
