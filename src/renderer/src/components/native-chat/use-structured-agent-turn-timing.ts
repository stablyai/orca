import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'
import type { StructuredAgentHostClock } from '../../../../shared/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../../shared/structured-agent-session-turn-timing'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from '../../../../shared/structured-agent-turn-clock-anchor'

/** Use journal durations and latch host-to-client clock conversion once per live turn to avoid clock skew. */
export function useStructuredAgentTurnTiming(
  {
    items,
    submissions,
    latestTurn,
    hostClock
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
    latestTurn?: AgentSessionLatestTurn | null
    hostClock?: StructuredAgentHostClock | null
  },
  turnId: string | null
): { settledTurns: NativeChatSettledTurns; workingStartedAt: number | null } {
  const { settledTurns, runningTiming } = useMemo(
    () => selectStructuredAgentTurnBars(items, submissions, turnId, latestTurn),
    [items, submissions, turnId, latestTurn]
  )
  const [latch, setLatch] = useState<StructuredAgentTurnClockLatch | null>(null)
  // Derive during render so the first paint of each turn already uses its correct start.
  const step = stepStructuredAgentTurnClock({
    timing: runningTiming,
    turnId,
    now: Date.now,
    hostClock,
    latch
  })
  if (step.latch !== latch) {
    setLatch(step.latch)
  }
  return { settledTurns, workingStartedAt: step.workingStartedAt }
}
