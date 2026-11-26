/** Provider thread-goal lifecycle. Open like other persisted vocabularies: a
 *  status a newer provider reports must not turn a row malformed. */
export const AGENT_JOURNAL_THREAD_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete'
] as const
export type AgentJournalThreadGoalStatus = (typeof AGENT_JOURNAL_THREAD_GOAL_STATUSES)[number]

/** The provider's goal as last journaled. Timestamps are epoch ms; counters are as of `updatedAt`. */
export type AgentJournalThreadGoal = {
  objective: string
  status: AgentJournalThreadGoalStatus
  statusDetail?: string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

/** A goal transition in typed form, so readers never parse a bounded frame head. */
export type AgentJournalThreadGoalState =
  | { state: 'set'; goal: AgentJournalThreadGoal }
  | { state: 'cleared' }
