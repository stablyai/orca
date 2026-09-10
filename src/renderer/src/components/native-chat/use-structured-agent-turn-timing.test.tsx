// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../../shared/agent-session-turn-record'
import { useStructuredAgentTurnTiming } from './use-structured-agent-turn-timing'

// Host clock sits an hour ahead of the client's so any leak of a host timestamp
// into the local anchor shows up as a huge offset.
const HOST_START = 3_600_000_000
const CLIENT_NOW = 12_345_000

function user(itemId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: HOST_START + sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }
  }
}

function lifecycle(
  turnId: string,
  sequence: number,
  turn: Omit<AgentJournalTurnLifecycle, 'turnId'>,
  observedAt: number
): AgentJournalRenderItem {
  return {
    itemId: `lifecycle-${turnId}`,
    revision: 1,
    sequence,
    observedAt,
    body: agentJournalTurnBody({ turnId, ...turn })
  }
}

/** The status carrier an older host writes in place of the turn item. */
function legacyLifecycle(
  turnId: string,
  sequence: number,
  turn: Omit<AgentJournalTurnLifecycle, 'turnId'>,
  observedAt: number
): AgentJournalRenderItem {
  return {
    ...lifecycle(turnId, sequence, turn, observedAt),
    body: { kind: 'status', text: 'Working', turnLifecycle: { turnId, ...turn } }
  }
}

// The submission the provider acknowledged under the key its lifecycle row cites.
const SUBMISSIONS: AgentJournalSubmission[] = [
  {
    clientMessageId: 'first',
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: 'codex:thread:t1:0',
    reason: null,
    submittedAt: 1,
    resolvedAt: 2
  }
]

afterEach(() => {
  vi.useRealTimers()
})

describe('useStructuredAgentTurnTiming', () => {
  it('hands settled host durations through and anchors the live counter locally, once per turn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    const running = [
      user('u1', 1),
      lifecycle(
        't1',
        2,
        {
          state: 'completed',
          startedAt: HOST_START,
          completedAt: HOST_START + 197_900,
          userItemId: 'codex:thread:t1:0'
        },
        HOST_START + 5
      ),
      user('u2', 3),
      // The host appended the row 2.5s after it saw the turn start.
      lifecycle(
        't2',
        4,
        { state: 'running', startedAt: HOST_START + 100_000 },
        HOST_START + 102_500
      )
    ]
    const { result, rerender } = renderHook(
      ({ items, turnId }: { items: AgentJournalRenderItem[]; turnId: string | null }) =>
        useStructuredAgentTurnTiming(items, SUBMISSIONS, turnId),
      { initialProps: { items: running, turnId: 't2' as string | null } }
    )
    expect(result.current.workingStartedAt).toBe(CLIENT_NOW - 2_500)
    // The row's provider key resolves through the submission alias, not journal order.
    expect([...result.current.settledTurns]).toEqual([
      ['orca:first', { startedAt: HOST_START, workedSeconds: 197 }]
    ])

    vi.setSystemTime(CLIENT_NOW + 30_000)
    rerender({ items: [...running], turnId: 't2' })
    expect(result.current.workingStartedAt).toBe(CLIENT_NOW - 2_500)

    rerender({ items: running, turnId: null })
    expect(result.current.workingStartedAt).toBeNull()

    vi.setSystemTime(CLIENT_NOW + 60_000)
    // An older host's status carrier still anchors the counter.
    const next = [
      ...running,
      user('u3', 5),
      legacyLifecycle(
        't3',
        6,
        { state: 'running', startedAt: HOST_START + 150_000 },
        HOST_START + 150_100
      )
    ]
    rerender({ items: next, turnId: 't3' })
    expect(result.current.workingStartedAt).toBe(CLIENT_NOW + 60_000 - 100)
  })

  it('leaves the anchor null when an older host records no start', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    const items = [user('u1', 1), lifecycle('t1', 2, { state: 'running' }, HOST_START)]
    const { result } = renderHook(() => useStructuredAgentTurnTiming(items, [], 't1'))
    expect(result.current.workingStartedAt).toBeNull()
    expect(result.current.settledTurns.size).toBe(0)
  })
})
