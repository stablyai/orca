import { currentAgentSessionThreadGoal } from './agent-session-thread-goal'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from './journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from './options/agent-session-options-result'

/** What clears a goal only the agent's own /goal changes. */
export const AGENT_OWNED_THREAD_GOAL_CLEAR_COMMAND = '/goal clear'

export type AgentSessionThreadGoalReport = {
  goal: AgentJournalThreadGoal | null
  /** False for an agent-owned /goal: clear goes through the agent's command and there is no pause. */
  hostChanges: boolean
}

/** Null unless the host advertises goal changes, or reports a goal the agent's own /goal set. */
export function agentSessionThreadGoalReport(args: {
  journalItems: readonly Pick<AgentJournalRenderItem, 'sequence' | 'body' | 'agentId'>[]
  support: AgentSessionOptionsResult['threadGoal']
  reported: AgentSessionOptionsResult['reportedThreadGoal']
  journalEpoch?: string | null
}): AgentSessionThreadGoalReport | null {
  const { journalItems, support, reported, journalEpoch } = args
  const report = support ?? reported
  if (report === undefined) {
    return null
  }
  // Loaded rows reach the live head and outrank older whole-journal goal evidence.
  const floor =
    report.contextFloor && (!journalEpoch || report.contextFloor.epoch === journalEpoch)
      ? report.contextFloor.sequence
      : 0
  const loaded = currentAgentSessionThreadGoal(journalItems, floor)
  const goal = loaded === undefined ? (report.current ?? null) : loaded
  const hostChanges = support !== undefined
  return !hostChanges && goal === null ? null : { goal, hostChanges }
}
