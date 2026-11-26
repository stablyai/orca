import type { AgentSessionGoalDisplay } from '../../../../../../shared/agent-session/thread-goals/agent-session-goal-check-display'
import { useCallback, useMemo, useState } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentOwnedThreadGoalCommand,
  agentSessionThreadGoalReport
} from '../../../../../../shared/agent-session/thread-goals/agent-session-thread-goal-report'
import type { AgentSessionOptionsResult } from '../../../../../../shared/agent-session/options/protocol/agent-session-options-result'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../../../../shared/agent-session/thread-goals/agent-session-thread-goal-wire'
import { getNativeChatAgentProfile } from '../../../../../../shared/native-chat/input/commands/native-chat-agent-profiles'
import type { StructuredAgentSessionMutate } from '../structured/writes/use-structured-agent-session-mutate'
import { rowsBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

export type StructuredAgentSessionThreadGoal = {
  goal: AgentSessionGoalDisplay | null
  pending: boolean
  /** False for agent-owned /goal: clear uses a command and pause is unavailable. */
  hostChanges: boolean
  /** An agent-owned goal resumes through the agent's `/goal resume`. */
  agentResumes: boolean
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
  agent: string
}): StructuredAgentSessionThreadGoal | null {
  const { journalItems, mutate, support, reported, journalEpoch, send } = args
  const agentResumes = getNativeChatAgentProfile(args.agent)?.resumesOwnGoal === true
  const [pendingCount, setPendingCount] = useState(0)
  const goalRows = rowsBesideStreamedText(journalItems)
  const report = useMemo(
    // Goal rows never carry reply text, so a streaming reply keeps the memo.
    () => agentSessionThreadGoalReport({ journalItems: goalRows, support, reported, journalEpoch }),
    [goalRows, support, reported, journalEpoch]
  )
  const hostChanges = support !== undefined
  const change = useCallback(
    async (next: AgentSessionThreadGoalChange): Promise<boolean> => {
      if (!hostChanges) {
        const command = agentOwnedThreadGoalCommand(next, agentResumes)
        return command !== null && send(command) !== false
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
    [agentResumes, hostChanges, mutate, send]
  )
  if (report === null) {
    return null
  }
  return { goal: report.goal, pending: pendingCount > 0, hostChanges, agentResumes, change }
}
