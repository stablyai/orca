import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { agentJournalTurnBody } from './agent-session-turn-record'
import {
  stepStructuredAgentTurnClock,
  type StructuredAgentTurnClockLatch
} from './structured-agent-turn-clock-anchor'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentRunningTurnTiming
} from './structured-agent-session-turn-timing'

// Separate host/client clocks by an hour so mixed-clock anchors fail visibly.
const HOST_START = 3_600_000_000
const CLIENT_NOW = 12_345_000

function lifecycle(
  turnId: string,
  turn: Omit<AgentJournalTurnLifecycle, 'turnId'>,
  observedAt: number
): AgentJournalRenderItem {
  return {
    itemId: `lifecycle-${turnId}`,
    revision: 1,
    sequence: 1,
    observedAt,
    body: agentJournalTurnBody({ turnId, ...turn })
  }
}

/** Append time equals provider start; zero append lag isolates the origin adjustment. */
function runningTurn(startedAt: number, requestedAt?: number): AgentJournalRenderItem[] {
  return [
    lifecycle(
      't1',
      { state: 'running', startedAt, ...(requestedAt === undefined ? {} : { requestedAt }) },
      startedAt
    )
  ]
}

function anchorFor(
  items: AgentJournalRenderItem[],
  hostClock: { hostNow: number; receivedAt: number } | null,
  latch: StructuredAgentTurnClockLatch | null = null
): { latch: StructuredAgentTurnClockLatch | null; workingStartedAt: number | null } {
  return stepStructuredAgentTurnClock({
    timing: selectStructuredAgentRunningTurnTiming(items, 't1'),
    turnId: 't1',
    now: () => CLIENT_NOW,
    hostClock,
    latch
  })
}

describe('structured agent turn clock anchor', () => {
  // Turn-open must not reset elapsed dispatch time; assert milliseconds because second-flooring hides the 898ms case.
  it.each([898, 7_051, 25_000])(
    'never counts backwards across turn-open with %ims of dispatch latency',
    (latencyMs) => {
      const requestedAt = HOST_START
      const startedAt = HOST_START + latencyMs
      const hostClock = { hostNow: startedAt, receivedAt: CLIENT_NOW }

      // Before the turn opens the surface counts from its own stamp at the send.
      const localStampAtSend = CLIENT_NOW - latencyMs
      const elapsedBefore = CLIENT_NOW - localStampAtSend

      const { workingStartedAt } = anchorFor(runningTurn(startedAt, requestedAt), hostClock)
      const elapsedAfter = CLIENT_NOW - (workingStartedAt ?? CLIENT_NOW)

      expect(elapsedAfter).toBeGreaterThanOrEqual(elapsedBefore)
      expect(workingStartedAt).toBe(localStampAtSend)
    }
  )

  // New host samples include new delivery latency; recomputing the offset could move the anchor later and run elapsed backwards.
  it('keeps the latched conversion when a later host sample carries more latency', () => {
    const items = runningTurn(HOST_START + 1_000, HOST_START)
    const first = anchorFor(items, { hostNow: HOST_START + 1_000, receivedAt: CLIENT_NOW })

    const jittered = anchorFor(
      items,
      { hostNow: HOST_START - 1_000, receivedAt: CLIENT_NOW },
      first.latch
    )

    expect(jittered.latch).toBe(first.latch)
    expect(jittered.workingStartedAt).toBe(first.workingStartedAt)
  })

  it('moves the anchor earlier, never later, when the origin improves', () => {
    const startedAt = HOST_START + 5_000
    const hostClock = { hostNow: startedAt, receivedAt: CLIENT_NOW }
    const withoutOrigin = anchorFor(runningTurn(startedAt), hostClock)

    const improved = anchorFor(runningTurn(startedAt, HOST_START), hostClock, withoutOrigin.latch)

    expect(improved.workingStartedAt).toBeLessThan(withoutOrigin.workingStartedAt ?? 0)
  })

  it('falls back to the provider turn-start when the host named no send', () => {
    const startedAt = HOST_START + 5_000
    const { workingStartedAt } = anchorFor(runningTurn(startedAt), {
      hostNow: startedAt,
      receivedAt: CLIENT_NOW
    })

    // Older hosts omit `requestedAt`; the reading is exactly what it is today.
    expect(workingStartedAt).toBe(CLIENT_NOW)
  })

  it('drops the latch when no turn is open', () => {
    const open = anchorFor(runningTurn(HOST_START + 1_000, HOST_START), {
      hostNow: HOST_START + 1_000,
      receivedAt: CLIENT_NOW
    })

    const closed = stepStructuredAgentTurnClock({
      timing: null,
      turnId: null,
      now: () => CLIENT_NOW,
      hostClock: null,
      latch: open.latch
    })

    expect(closed.latch).toBeNull()
    expect(closed.workingStartedAt).toBeNull()
  })
})

describe('structured agent turn origin', () => {
  // Live and settled timing must share an origin or completion contradicts the counter.
  it('settles a turn from the same instant the live counter used', () => {
    const settled = completedStructuredAgentTurnSeconds({
      state: 'completed',
      startedAt: HOST_START + 25_000,
      requestedAt: HOST_START,
      completedAt: HOST_START + 26_000,
      observedAt: HOST_START + 25_000
    })

    expect(settled).toBe(26)
  })

  it('does not let a provider start-scoped duration undercut an exact request origin', () => {
    const settled = completedStructuredAgentTurnSeconds({
      state: 'completed',
      startedAt: HOST_START + 25_000,
      requestedAt: HOST_START,
      completedAt: HOST_START + 26_000,
      durationMs: 7_612,
      observedAt: HOST_START + 25_000
    })

    expect(settled).toBe(26)
  })

  it('falls back to the provider duration when the host did not observe completion', () => {
    const settled = completedStructuredAgentTurnSeconds({
      state: 'completed',
      startedAt: HOST_START + 25_000,
      requestedAt: HOST_START,
      durationMs: 7_612,
      observedAt: HOST_START + 25_000
    })

    expect(settled).toBe(7)
  })

  it('clamps a settled host interval when the wall clock moved backward', () => {
    const settled = completedStructuredAgentTurnSeconds({
      state: 'interrupted',
      startedAt: HOST_START - 2_000,
      requestedAt: HOST_START,
      completedAt: HOST_START - 1_000,
      observedAt: HOST_START - 2_000
    })

    expect(settled).toBe(0)
  })
})
