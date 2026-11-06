// Current work accompanies latestTurn on history pages and batches.

export type AgentSessionCurrentWorkFields = {
  /** Pending approvals/questions across the journal from the live agent only; ended agents cannot receive answers. Older hosts omit this and clients use loaded pending rows. */
  actionablePromptIds?: string[]
  /** Host-projected work: a running turn or eligible/handed-over unanswered send. Ended agents do not count; older hosts omit this and clients derive it from loaded rows. */
  working?: boolean
}
