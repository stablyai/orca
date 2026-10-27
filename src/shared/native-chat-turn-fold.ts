// Derive settled-turn answers from the last assistant prose or system failure; the journal has no answer marker.
// Earlier work/recovered errors fold behind that answer, while failed turns end visibly on their error.

import { AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION } from './agent-session-compaction'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from './agent-session-orca-stop'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from './agent-session-turn-notice'
import { nativeChatRowRendersContent } from './native-chat-row-content'
import { isStoppedBeforeStartBlock } from './native-chat/native-chat-stopped-before-start'
import { nativeChatRowRendersProse } from './native-chat/native-chat-trailing-run'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatMessage,
  type NativeChatRole
} from './native-chat-types'

/** Each surface supplies its own row-content results so folding sees exactly the prose it renders. */
export type NativeChatTurnFoldRow = {
  /** The turn this row belongs to; undefined before the first user message. */
  turnKey: string | undefined
  role: NativeChatRole
  /** Whether the row draws prose — the only thing that can be an answer. */
  rendersProse: boolean
  /** Invisible rows cannot justify a disclosure: they hide nothing. */
  draws: boolean
  /** Spawn/task rows outlive their turn and may be the only outcome report; never fold them. */
  outlivesTurn: boolean
  /** System failures compete as final answers so failed turns end on visible errors. */
  reportsFailure: boolean
  /** Compaction/interruption/turn notices remain visible; hiding them leaves only generic turn status. */
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
    // Use raw roster blocks: empty rosters render no block, making their plain-text twin the sole spawn record.
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
  /** Offer disclosure only for turns that actually hide rows. */
  foldableTurnKeys: ReadonlySet<string>
}

export const NATIVE_CHAT_EMPTY_TURN_FOLD: NativeChatTurnFold = {
  foldedRows: new Set(),
  foldableTurnKeys: new Set()
}

/** Last assistant prose/system failure per turn; no answer means fold all work. */
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

/** Fold settled, unexpanded turns when they gain a duration/status row. Running turns stay open; newly settled turns start collapsed without separate disclosure cleanup. */
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
    // User anchors, durable task/roster reports and turn explanations remain outside the fold.
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
    // No-prose turns fold wholly behind the status anchor instead of leaving every command expanded.
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
