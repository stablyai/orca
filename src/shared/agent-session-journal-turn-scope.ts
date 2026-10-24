/** Which turn a row belongs to, stated by the write that created it. `turn` names the turn
 *  record's journal key; `thread` is a row that belongs to no turn — a notice about the
 *  conversation, or a message not yet delivered into one. Turn records themselves are `thread`. */
export type AgentJournalTurnScope =
  | { kind: 'turn'; turnItemId: string }
  | { kind: 'thread' }
  /** The available source cannot identify the owning native turn. */
  | { kind: 'unknown' }
