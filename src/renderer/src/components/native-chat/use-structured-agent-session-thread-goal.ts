import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session-journal-types'
import { currentAgentSessionThreadGoal } from '../../../../shared/agent-session-thread-goal'
import type {
  AgentSessionOptionsResult,
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

export type StructuredAgentSessionThreadGoal = {
  goal: AgentJournalThreadGoal | null
  pending: boolean
  /** Resolves false when the change was refused or not sent; the error surfaces separately. */
  change: (change: AgentSessionThreadGoalChange) => Promise<boolean>
}

/** Null unless the host reported it can change this session's goal. */
export function useStructuredAgentSessionThreadGoal(args: {
  journalItems: readonly AgentJournalRenderItem[]
  support: AgentSessionOptionsResult['threadGoal']
  mutate: StructuredAgentSessionMutate
}): StructuredAgentSessionThreadGoal | null {
  const { journalItems, mutate, support } = args
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  // The loaded window reaches the live head, so a goal row in it is newer than the
  // host's whole-journal answer; that answer covers only rows older than the window.
  const loaded = useMemo(() => currentAgentSessionThreadGoal(journalItems), [journalItems])
  const goal = loaded === undefined ? (support?.current ?? null) : loaded
  const change = useCallback(
    async (next: AgentSessionThreadGoalChange): Promise<boolean> => {
      if (pendingRef.current) {
        return false
      }
      pendingRef.current = true
      setPending(true)
      try {
        const result = await mutate<AgentSessionThreadGoalResult>(
          'agentSession.threadGoal',
          'agentSession.threadGoal',
          { change: next }
        )
        return result !== null
      } finally {
        pendingRef.current = false
        setPending(false)
      }
    },
    [mutate]
  )
  return support ? { goal, pending, change } : null
}
