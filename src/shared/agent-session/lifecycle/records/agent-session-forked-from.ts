/** The chat a fork was copied from, saved on the fork's record. */
export type AgentSessionForkedFrom = {
  sessionId: string
  /** The source response whose turn the fork copied through. */
  itemId: string
  /** Where the inherited history ends in this chat's own journal. */
  childBoundary: { kind: 'item'; itemId: string } | { kind: 'start' }
  /** Saved under the source's shown name; absent on forks older builds titled "<source> fork". */
  plainName?: true
}
