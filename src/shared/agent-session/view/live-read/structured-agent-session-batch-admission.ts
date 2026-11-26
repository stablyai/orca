import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'

/** The one batch rule: same epoch, and never behind the applied cursor. The reducer and the
 *  exact-command latch share it, so the latch never grants from a frame the reducer drops. */
export function admitsAgentSessionBatch(
  state: { epoch: string | null; cursor: AgentJournalCursor | null },
  cursor: AgentJournalCursor
): boolean {
  return state.epoch === cursor.epoch && !(state.cursor && cursor.sequence < state.cursor.sequence)
}
