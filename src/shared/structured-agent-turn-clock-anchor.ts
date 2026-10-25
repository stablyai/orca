// Latch one host-to-client conversion per turn on desktop/mobile. receivedAt - hostNow includes sample delivery latency;
// recomputing on later frames imports jitter and can move the anchor later, making elapsed go backwards.
// Keep the offset fixed so improved origins only move the anchor earlier.

import type { StructuredAgentHostClock } from './structured-agent-session-reducer'
import {
  structuredAgentTurnLocalStartedAt,
  type StructuredAgentTurnTiming
} from './structured-agent-session-turn-timing'

/** Stamp conversion basis once per turn: first client sighting and host clock advanced to that instant. */
export type StructuredAgentTurnClockLatch = {
  turnId: string
  firstSeenAt: number
  /** Absent until a host sample has arrived; the row's append time applies instead. */
  hostNow?: number
}

export function latchStructuredAgentTurnClock(
  turnId: string,
  now: number,
  hostClock: StructuredAgentHostClock | null | undefined
): StructuredAgentTurnClockLatch {
  return {
    turnId,
    firstSeenAt: now,
    ...(hostClock ? { hostNow: hostClock.hostNow + (now - hostClock.receivedAt) } : {})
  }
}

/** Lazy clock read avoids treating rerenders of a latched turn as new sightings. */
export type StructuredAgentTurnClockReader = () => number

/** Retain latch identity while the turn holds so callers can compare references. */
export function stepStructuredAgentTurnClock(input: {
  timing: StructuredAgentTurnTiming | null
  turnId: string | null
  now: StructuredAgentTurnClockReader
  hostClock: StructuredAgentHostClock | null | undefined
  latch: StructuredAgentTurnClockLatch | null
}): { latch: StructuredAgentTurnClockLatch | null; workingStartedAt: number | null } {
  const { timing, turnId, latch } = input
  if (turnId === null) {
    return { latch: null, workingStartedAt: null }
  }
  const next =
    latch?.turnId === turnId
      ? latch
      : latchStructuredAgentTurnClock(turnId, input.now(), input.hostClock)
  return {
    latch: next,
    workingStartedAt: timing
      ? structuredAgentTurnLocalStartedAt(timing, next.firstSeenAt, next.hostNow)
      : null
  }
}
