// Which rows a settled turn folds behind its "Worked for N" status row.
//
// A turn's answer is its last assistant row that renders prose, or its last
// failure report; everything before it is the work that produced it. The journal
// carries no "this one is the answer" marker on a message, so the answer is
// derived rather than read — last candidate wins. So a failed turn ends on its
// error, and an error the agent recovered from folds behind the answer after it.

import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { NativeChatRole } from './native-chat-types'

/** What the fold needs to know about one transcript row. Deliberately not a
 *  `NativeChatMessage`: each surface derives "renders prose" through its own
 *  row-content pass, and the fold must read the same answer that pass draws. */
export type NativeChatTurnFoldRow = {
  /** The turn this row belongs to; undefined before the first user message. */
  turnKey: string | undefined
  role: NativeChatRole
  /** Whether the row draws prose — the only thing that can be an answer. */
  rendersProse: boolean
  /** Whether the row carries work that outlives the turn that started it: a
   *  spawn roster or a background task. That row is the durable report of how
   *  the work ended — often the only one — so it never folds. */
  outlivesTurn: boolean
  /** Whether a system row reports a failure. It competes with prose to be the
   *  turn's answer, so a turn that failed shows the error as its end. */
  reportsFailure: boolean
  /** Whether the row reports a compaction's result. It never folds: hiding it
   *  would leave the turn's status as the only trace the context was rewritten. */
  reportsCompaction: boolean
  /** The subagent that produced the row. Absent ⇒ the session's own agent. */
  agentId?: string
}

export type NativeChatTurnFold = {
  /** Rows a folded turn must not draw, by index. */
  foldedRows: ReadonlySet<number>
  /** Turns that actually hide something, so a surface offers the disclosure only
   *  where there is something behind it. */
  foldableTurnKeys: ReadonlySet<string>
}

export const NATIVE_CHAT_EMPTY_TURN_FOLD: NativeChatTurnFold = {
  foldedRows: new Set(),
  foldableTurnKeys: new Set()
}

/** The index of each turn's answer: the last prose the session's own agent
 *  wrote, or its last system row reporting a failure. A subagent that is still
 *  narrating after its parent's last word would otherwise stand as the turn's
 *  only visible reply. A turn with neither has no answer, and folds whole. */
export function nativeChatTurnAnswerRows(
  rows: readonly NativeChatTurnFoldRow[]
): ReadonlyMap<string, number> {
  const answers = new Map<string, number>()
  for (const [index, row] of rows.entries()) {
    const isCandidate =
      row.rendersProse &&
      isRootAgentJournalItem(row) &&
      (row.role === 'assistant' || (row.role === 'system' && row.reportsFailure))
    if (row.turnKey !== undefined && isCandidate) {
      answers.set(row.turnKey, index)
    }
  }
  return answers
}

/**
 * Fold every settled, unexpanded turn to its answer.
 *
 * `settledTurnKeys` is the gate, not a working flag: a turn folds once it has a
 * duration to show, which is exactly when its status row appears. A running turn
 * is therefore never folded, and nothing has to close the disclosure when the
 * turn ends — the fold arrives already closed, because the turn joined the set
 * of turns that have a duration.
 */
export function nativeChatTurnFold({
  rows,
  settledTurnKeys,
  expandedTurnKeys
}: {
  rows: readonly NativeChatTurnFoldRow[]
  settledTurnKeys: ReadonlySet<string>
  expandedTurnKeys: ReadonlySet<string>
}): NativeChatTurnFold {
  const answers = nativeChatTurnAnswerRows(rows)
  const foldedRows = new Set<number>()
  const foldableTurnKeys = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const { turnKey } = row
    // Outside the fold by construction: the reader's own message anchors the
    // turn, a roster or background-task row outlives it, and a compaction report explains it.
    if (
      turnKey === undefined ||
      row.role === 'user' ||
      row.outlivesTurn ||
      row.reportsCompaction ||
      !settledTurnKeys.has(turnKey)
    ) {
      continue
    }
    // A turn that produced no prose folds whole: its status row is the anchor,
    // so there is still something on screen to open. Keeping such a turn
    // unfolded instead would put every command it ran back in the transcript.
    if (index === answers.get(turnKey)) {
      continue
    }
    foldableTurnKeys.add(turnKey)
    if (!expandedTurnKeys.has(turnKey)) {
      foldedRows.add(index)
    }
  }
  return { foldedRows, foldableTurnKeys }
}
