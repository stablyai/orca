// Which rows a settled turn folds behind its "Worked for N" status row.
//
// A turn's answer is its last assistant row that renders prose, or its last
// failure report; everything before it is the work that produced it. The journal
// carries no "this one is the answer" marker on a message, so the answer is
// derived rather than read — last candidate wins. So a failed turn ends on its
// error, and an error the agent recovered from folds behind the answer after it.

import { AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION } from './agent-session-compaction'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from './agent-session-orca-stop'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from './agent-session-turn-notice'
import { nativeChatRowRendersContent } from './native-chat-row-content'
import { isStoppedBeforeStartBlock } from './native-chat-stopped-before-start'
import { nativeChatRowRendersProse } from './native-chat-trailing-run'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatMessage,
  type NativeChatRole
} from './native-chat-types'

/** What the fold needs to know about one transcript row. Deliberately not a
 *  `NativeChatMessage`: each surface derives "renders prose" through its own
 *  row-content pass, and the fold must read the same answer that pass draws. */
export type NativeChatTurnFoldRow = {
  /** The turn this row belongs to; undefined before the first user message. */
  turnKey: string | undefined
  role: NativeChatRole
  /** Whether the row draws prose — the only thing that can be an answer. */
  rendersProse: boolean
  /** Whether the row draws anything when unfolded. One that draws nothing hides nothing, so it
   *  never makes its turn offer the disclosure. */
  draws: boolean
  /** Whether the row carries work that outlives the turn that started it: a
   *  spawn roster or a background task. That row is the durable report of how
   *  the work ended — often the only one — so it never folds. */
  outlivesTurn: boolean
  /** Whether a system row reports a failure. It competes with prose to be the
   *  turn's answer, so a turn that failed shows the error as its end. */
  reportsFailure: boolean
  /** Whether the row explains what became of the turn: a compaction's result, that
   *  the response was interrupted, or a `turn-notice` row. It never folds: hiding
   *  it would leave the turn's status as the only trace of it. */
  explainsTurn: boolean
}

/** How the fold reads a transcript row, with the same derivation the row renders from. */
export function nativeChatTurnFoldRow(
  message: NativeChatMessage,
  turnKey: string | undefined,
  hasReceipt: boolean
): NativeChatTurnFoldRow {
  return {
    turnKey,
    role: message.role,
    rendersProse: nativeChatRowRendersProse(message),
    draws: hasReceipt || nativeChatRowRendersContent(message.blocks),
    // The raw blocks, not the renderable ones: a childless roster draws no row
    // and its plain-text twin is then the only record the spawn happened.
    outlivesTurn: message.blocks.some(
      (block) =>
        isSubagentGroupBlock(block) ||
        isBackgroundTaskBlock(block) ||
        isStoppedBeforeStartBlock(block)
    ),
    // A row about Orca's own stop is stored red for clients that predate it; it reports no failure.
    reportsFailure: message.blocks.some(
      (block) =>
        block.type === 'text' &&
        (block.tone === 'error' || block.failure?.kind === 'usageLimitReached') &&
        block.presentation !== AGENT_SESSION_ORCA_STOP_PRESENTATION
    ),
    explainsTurn: message.blocks.some(
      (block) =>
        block.type === 'text' &&
        (block.presentation === 'compaction' ||
          block.presentation === AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION ||
          block.presentation === AGENT_SESSION_ORCA_STOP_PRESENTATION ||
          block.presentation === AGENT_SESSION_TURN_NOTICE_PRESENTATION)
    )
  }
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

/** The index of each turn's answer: its last assistant row that renders prose,
 *  or its last system row reporting a failure. A turn with neither has no answer,
 *  and folds whole. */
export function nativeChatTurnAnswerRows(
  rows: readonly NativeChatTurnFoldRow[]
): ReadonlyMap<string, number> {
  const answers = new Map<string, number>()
  for (const [index, row] of rows.entries()) {
    const isCandidate =
      row.rendersProse &&
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
    // turn, a roster or background-task row outlives it, and a compaction report or interruption
    // notice explains it.
    if (
      turnKey === undefined ||
      row.role === 'user' ||
      !row.draws ||
      row.outlivesTurn ||
      row.explainsTurn ||
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
