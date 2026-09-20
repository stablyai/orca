import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import type { StructuredAgentHostClock } from '../../../../shared/structured-agent-session-reducer'
import {
  selectStructuredAgentRunningTurnTiming,
  selectStructuredAgentSettledTurns
} from '../../../../shared/structured-agent-session-turn-timing'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from '../../../../shared/structured-agent-turn-clock-anchor'

/** Host-recorded turn timing for the structured lane: settled durations straight
 *  off the journal, and a skew-free start for the live counter whose host-to-local
 *  conversion is latched once per turn. */
export function useStructuredAgentTurnTiming(
  {
    items,
    submissions,
    hostClock
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
    hostClock?: StructuredAgentHostClock | null
  },
  turnId: string | null
): { settledTurns: NativeChatSettledTurns; workingStartedAt: number | null } {
  const settledTurns = useMemo(
    () => selectStructuredAgentSettledTurns(items, submissions),
    [items, submissions]
  )
  const [latch, setLatch] = useState<StructuredAgentTurnClockLatch | null>(null)
  const runningTiming = useMemo(
    () => (turnId === null ? null : selectStructuredAgentRunningTurnTiming(items, turnId)),
    [items, turnId]
  )
  // Stamp during render (React's derive-from-props pattern) so the first paint of
  // a new turn already counts from the right instant.
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
