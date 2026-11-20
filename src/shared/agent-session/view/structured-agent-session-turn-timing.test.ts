import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { selectStructuredAgentSettledTurns } from './structured-agent-session-turn-timing'

let sequence = 0

const turn = (
  itemId: string,
  userItemId: string,
  times: { requestedAt?: number; startedAt: number; completedAt: number }
): AgentJournalRenderItem => ({
  itemId,
  revision: 0,
  sequence: ++sequence,
  observedAt: times.startedAt,
  body: { kind: 'turn', turnId: itemId, state: 'completed', userItemId, ...times }
})

const said = (itemId: string): AgentJournalRenderItem => ({
  itemId,
  revision: 0,
  sequence: ++sequence,
  observedAt: 0,
  body: { kind: 'message', role: 'user', blocks: [] }
})

describe('structured agent turn "Worked for"', () => {
  // "Sending…" clears at handover, so the clock the user watched began there, not at the first reply.
  it('counts from the handover, not from the provider turn start', () => {
    const settled = selectStructuredAgentSettledTurns([
      said('orca:c1'),
      turn('t1', 'orca:c1', { requestedAt: 10_000, startedAt: 25_000, completedAt: 40_000 })
    ])
    expect(settled.get('orca:c1')?.workedSeconds).toBe(30)
  })

  it('leaves out time spent waiting behind the previous turn', () => {
    const settled = selectStructuredAgentSettledTurns([
      said('orca:c0'),
      turn('t0', 'orca:c0', { startedAt: 1_000, completedAt: 20_000 }),
      said('orca:c1'),
      turn('t1', 'orca:c1', { requestedAt: 10_000, startedAt: 25_000, completedAt: 40_000 })
    ])
    expect(settled.get('orca:c1')?.workedSeconds).toBe(20)
  })
})
