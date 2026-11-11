/** `agentSession.workState`: the facts a waiter decides from, read without a history page. */
export type AgentSessionWorkState = {
  working: boolean
  /** A question or approval is waiting for the user. */
  actionablePrompt: boolean
  /** Absent = the host makes no queue claim. */
  queuedMessageIds?: string[]
  /** With queuedMessageIds, the next unblocked send; null while held. */
  nextQueuedMessageId?: string | null
  /** The session's current runtime fence, as history pages state it. */
  fence?: number
}
