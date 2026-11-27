import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { isAgentSessionContextClear } from '../conversation-context/agent-session-context-clear'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../journal/agent-session-journal-types'
import {
  currentAgentSessionThreadGoal,
  isAgentJournalThreadGoalRow
} from './agent-session-thread-goal'

export const AGENT_SESSION_GOAL_CHECK_PRESENTATION = 'goal-check'

/** View-only counters derived from notices; never persisted on the provider's goal. */
export type AgentSessionGoalDisplay = AgentJournalThreadGoal & {
  checks?: number
  lastCheck?: string
}

export function agentSessionGoalCheckDisplay(
  fallback: AgentJournalThreadGoal | null,
  items: readonly Pick<AgentJournalRenderItem, 'sequence' | 'body' | 'agentId'>[],
  minimumSequence = 0
): AgentSessionGoalDisplay | null {
  let goal = fallback
  let checks = 0
  let lastCheck: string | undefined
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.sequence <= minimumSequence) {
      break
    }
    if (isAgentSessionContextClear(item.body)) {
      return null
    }
    if (!isRootAgentJournalItem(item)) {
      continue
    }
    if (isAgentJournalThreadGoalRow(item.body)) {
      goal = currentAgentSessionThreadGoal([item]) ?? null
      break
    }
    if (
      item.body.kind === 'status' &&
      item.body.presentation === AGENT_SESSION_GOAL_CHECK_PRESENTATION
    ) {
      checks++
      lastCheck ??= item.body.text.replace(/^Stop hook feedback: /u, '')
    }
  }
  return goal && checks ? { ...goal, checks, lastCheck } : goal
}
