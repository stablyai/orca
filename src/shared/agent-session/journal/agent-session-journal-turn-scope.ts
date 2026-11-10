// turn names its owning journal turn key; thread has no owning turn and includes turn records themselves.
export type AgentJournalTurnScope =
  | { kind: 'turn'; turnItemId: string }
  | { kind: 'thread' }
  /** The available source cannot identify the owning native turn. */
  | { kind: 'unknown' }
