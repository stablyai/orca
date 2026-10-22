// The current-work part of the agent-session wire: what the host's projection of the agent running
// now says, riding with `latestTurn` on history pages and batches.

export type AgentSessionCurrentWorkFields = {
  /** The approvals and questions still waiting on the person that the agent running now raised,
   *  over the whole journal. One an agent that has ended raised is not listed, since nothing can
   *  take its answer. Absent from an older host, whose clients read every pending prompt they hold
   *  as waiting. */
  actionablePromptIds?: string[]
  /** Whether the agent running now is working, by the host's projection of current work — its
   *  running turn, or a send it owes, eligible or handed over and unanswered. What an agent that has
   *  ended left counts for nothing. Absent from an older host, whose clients derive it from the
   *  rows they hold. */
  working?: boolean
}
