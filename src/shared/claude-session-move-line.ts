import type { ClaudeSessionMoveSummary } from './managed-account-types'

/** One row of `orca account moves`. Callers that want newest first sort before this. */
export function formatClaudeSessionMoveLine(move: ClaudeSessionMoveSummary): string {
  const pane = move.paneKey ?? move.ptyId
  const to = move.toAccountId ?? '-'
  const strategy = move.strategy ?? '-'
  const chat = move.chat ? '  chat' : ''
  return `${new Date(move.at).toISOString()}  ${pane}  ${move.fromAccountId} → ${to}  ${move.reason}  ${strategy}${chat}`
}

/** The text `orca account moves` prints for a non-empty list. */
export function formatClaudeSessionMoveList(moves: readonly ClaudeSessionMoveSummary[]): string {
  return moves.map((move) => formatClaudeSessionMoveLine(move)).join('\n')
}
