// Whether the user has seen an agent's current state, by Orca's existing acknowledgement: the rule
// that un-bolds a sidebar row and that auto-acknowledgement, dashboard buckets, notification
// acknowledgement and the Activity unread count read beside an entry's state. A turn cut short with
// nobody asking reads failed only until this holds for its attention clock. Per-event Activity unread
// compares event times and keeps its own comparison.

/** An agent's current state beside the newest time the user acknowledged it, joined where the
 *  entry is read so no surface can leave the acknowledgement out. */
export type AgentTurnAcknowledgement = {
  /** When the agent entered its current state. */
  stateStartedAt: number
  /** When the user last acknowledged the agent; undefined when never. */
  acknowledgedAt: number | undefined
}

/** Compared with `stateStartedAt`, not the newest update, so a same-state ping is not new news. */
export function isAgentTurnAcknowledged({
  stateStartedAt,
  acknowledgedAt
}: AgentTurnAcknowledgement): boolean {
  return (acknowledgedAt ?? 0) >= stateStartedAt
}

/**
 * When the agent's newest news began: the row's combined state, or the main agent's own state when
 * that came later. Child work can hold the row open past the main agent's end, so a cut the user
 * has not seen must not count as seen by an acknowledgement of the work before it.
 */
export function agentAttentionStartedAt(entry: {
  stateStartedAt: number
  mainAgent?: { stateStartedAt?: number }
}): number {
  return Math.max(entry.stateStartedAt, entry.mainAgent?.stateStartedAt ?? 0)
}
