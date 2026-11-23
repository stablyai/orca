import { useMemo, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { AgentSessionLatestTurn } from '../../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentHostClock } from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../../../../shared/agent-session/view/structured-agent-session-turn-timing'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from '../../../../../../shared/native-chat/transcript/turns/structured-agent-turn-clock-anchor'

/** Use journal durations and latch host-to-client clock conversion once per live turn to avoid clock skew. */
export function useStructuredAgentTurnTiming(
  {
    items,
    submissions,
    latestTurn,
    working,
    hostClock
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
    latestTurn?: AgentSessionLatestTurn | null
    working?: boolean
    hostClock?: StructuredAgentHostClock | null
  },
  turnId: string | null
): { settledTurns: NativeChatSettledTurns; workingStartedAt: number | null } {
  const { settledTurns, runningTiming, runningKey } = useMemo(
    () => selectStructuredAgentTurnBars(items, submissions, turnId, latestTurn),
    [items, submissions, turnId, latestTurn]
  )
  const [latch, setLatch] = useState<StructuredAgentTurnClockLatch | null>(null)
  const opening = runningKey !== null && runningKey !== turnId
  // Derive during render so the first paint of each turn already uses its correct start.
  const step = stepStructuredAgentTurnClock({
    timing: runningTiming,
    // A send's early clock only while the agent works, so an idle viewer never gets a "Worked for" without a turn.
    turnId: opening && working !== true ? null : runningKey,
    opening,
    now: Date.now,
    hostClock,
    latch
  })
  if (step.latch !== latch) {
    setLatch(step.latch)
  }
  return { settledTurns, workingStartedAt: step.workingStartedAt }
}
