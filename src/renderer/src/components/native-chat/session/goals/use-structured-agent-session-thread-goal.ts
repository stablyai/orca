import { useCallback, useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_OWNED_THREAD_GOAL_CLEAR_COMMAND,
  agentSessionThreadGoalReport
} from '../../../../../../shared/agent-session/agent-session-thread-goal-report'
import type { AgentSessionOptionsResult } from '../../../../../../shared/agent-session/options/agent-session-options-result'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../../../../shared/agent-session/agent-session-thread-goal-wire'
import type { StructuredAgentSessionMutate } from '../structured/writes/use-structured-agent-session-mutate'

export type StructuredAgentSessionThreadGoal = {
  goal: AgentJournalThreadGoal | null
  pending: boolean
  /** False for agent-owned /goal: clear uses a command and pause is unavailable. */
  hostChanges: boolean
  /** Resolves false when the change was refused or not sent; the error surfaces separately. */
  change: (change: AgentSessionThreadGoalChange) => Promise<boolean>
}

/** Null unless the host advertises goal changes or goal reports for this session. */
export function useStructuredAgentSessionThreadGoal(args: {
  journalItems: readonly AgentJournalRenderItem[]
  support: AgentSessionOptionsResult['threadGoal']
  reported: AgentSessionOptionsResult['reportedThreadGoal']
  journalEpoch?: string | null
  mutate: StructuredAgentSessionMutate
  /** Sends the agent a command, for a goal only its own `/goal` changes. */
  send: (text: string) => boolean | 'queued'
}): StructuredAgentSessionThreadGoal | null {
  const { journalItems, mutate, support, reported, journalEpoch, send } = args
  const [pendingCount, setPendingCount] = useState(0)
  const report = useMemo(
    () => agentSessionThreadGoalReport({ journalItems, support, reported, journalEpoch }),
    [journalItems, support, reported, journalEpoch]
  )
  const hostChanges = support !== undefined
  const change = useCallback(
    async (next: AgentSessionThreadGoalChange): Promise<boolean> => {
      if (!hostChanges) {
        return next.kind === 'clear' && send(AGENT_OWNED_THREAD_GOAL_CLEAR_COMMAND) !== false
      }
      setPendingCount((count) => count + 1)
      try {
        const result = await mutate<AgentSessionThreadGoalResult>(
          'agentSession.threadGoal',
          'agentSession.threadGoal',
          { change: next }
        )
        return result !== null
      } finally {
        setPendingCount((count) => count - 1)
      }
    },
    [hostChanges, mutate, send]
  )
  if (report === null) {
    return null
  }
  return { goal: report.goal, pending: pendingCount > 0, hostChanges, change }
}
