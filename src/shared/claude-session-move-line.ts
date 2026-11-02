import type { ClaudeSessionMoveSummary } from './managed-account-types'

/** One recent-move row. Callers that want newest first sort before this. */
export function formatClaudeSessionMoveLine(move: ClaudeSessionMoveSummary): string {
  const pane = move.paneKey ?? move.ptyId
  const to = move.toAccountId ?? '-'
  const strategy = move.strategy ?? '-'
  return `${new Date(move.at).toISOString()}  ${pane}  ${move.fromAccountId} → ${to}  ${move.reason}  ${strategy}`
}

/** The recent-move list, one row per line. */
export function formatClaudeSessionMoveList(moves: readonly ClaudeSessionMoveSummary[]): string {
  return moves.map((move) => formatClaudeSessionMoveLine(move)).join('\n')
}
