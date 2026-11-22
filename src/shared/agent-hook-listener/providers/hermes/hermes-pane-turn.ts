export type HermesPaneTurn = {
  ended: boolean
  /** `delegate_task` children seen in this pane; they run their own turns under their own session ids. */
  childSessionIds: Set<string>
  /** The pane's own session, which its children's hooks must not replace. */
  sessionId: string
}
