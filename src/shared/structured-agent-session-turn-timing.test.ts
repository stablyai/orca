import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { selectNativeChatTurnStatuses } from './native-chat-turn-status'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentRunningTurnTiming,
  selectStructuredAgentSettledTurns,
  selectStructuredAgentTurnTimings,
  structuredAgentTurnLocalStartedAt
} from './structured-agent-session-turn-timing'

let sequence = 0
function user(itemId: string): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: 1_000 + sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }
  }
}
function lifecycle(
  turnId: string,
  lifecycle: Partial<
    NonNullable<AgentJournalRenderItem['body'] & { kind: 'status' }>['turnLifecycle']
  >,
  observedAt = 1_000 + sequence + 1
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `legacy:codex:s:turn-lifecycle%3A${turnId}`,
    revision: 1,
    sequence,
    observedAt,
    body: {
      kind: 'status',
      text: 'Codex is working…',
      turnLifecycle: { turnId, state: 'running', ...lifecycle }
    }
  }
}
function assistant(): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `a${sequence}`,
    revision: 0,
    sequence,
    observedAt: 1_000 + sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
  }
}

describe('selectStructuredAgentTurnTimings', () => {
  it('keys each timed lifecycle row by the user message that opened the turn', () => {
    const items = [
      user('u1'),
      lifecycle('t1', { state: 'completed', startedAt: 10_000, completedAt: 197_500 }),
      assistant(),
      user('u2'),
      lifecycle('t2', { state: 'running', startedAt: 300_000 })
    ]
    const timings = selectStructuredAgentTurnTimings(items)
    expect(timings.get('u1')).toMatchObject({
      state: 'completed',
      startedAt: 10_000,
      completedAt: 197_500
    })
    expect(timings.get('u2')).toMatchObject({ state: 'running', startedAt: 300_000 })
    expect(timings.get('u2')?.completedAt).toBeUndefined()
  })

  it('skips lifecycle rows that carry no start (older hosts, conversation commands)', () => {
    const items = [user('u1'), lifecycle('compact:1', {})]
    expect(selectStructuredAgentTurnTimings(items).size).toBe(0)
  })

  it('gives a prompt folded into a running turn no timing of its own', () => {
    const items = [
      user('u1'),
      lifecycle('t1', { state: 'completed', startedAt: 5_000, completedAt: 9_000 }),
      user('u2-steer'),
      assistant()
    ]
    const timings = selectStructuredAgentTurnTimings(items)
    expect([...timings.keys()]).toEqual(['u1'])
  })

  it('drops an end that precedes its start', () => {
    const items = [
      user('u1'),
      lifecycle('t1', { state: 'completed', startedAt: 9_000, completedAt: 5_000 })
    ]
    expect(selectStructuredAgentTurnTimings(items).get('u1')?.completedAt).toBeUndefined()
  })
})

describe('completedStructuredAgentTurnSeconds', () => {
  it('floors whole seconds for completed and interrupted turns', () => {
    expect(
      completedStructuredAgentTurnSeconds({
        state: 'completed',
        startedAt: 1_000,
        completedAt: 188_900,
        observedAt: 1_000
      })
    ).toBe(187)
    expect(
      completedStructuredAgentTurnSeconds({
        state: 'interrupted',
        startedAt: 1_000,
        completedAt: 4_999,
        observedAt: 1_000
      })
    ).toBe(3)
  })

  it('claims nothing for running or unverifiable turns', () => {
    expect(
      completedStructuredAgentTurnSeconds({ state: 'running', startedAt: 1_000, observedAt: 1_000 })
    ).toBeNull()
    expect(
      completedStructuredAgentTurnSeconds({
        state: 'unverifiable',
        startedAt: 1_000,
        observedAt: 1_000
      })
    ).toBeNull()
    expect(completedStructuredAgentTurnSeconds(undefined)).toBeNull()
  })
})

describe('structuredAgentTurnLocalStartedAt', () => {
  it('moves the local first sighting back by the host-side append lag only', () => {
    const timing = { state: 'running' as const, startedAt: 50_000, observedAt: 52_500 }
    // Client clock is 1h ahead of the host: the anchor must not inherit that skew.
    expect(structuredAgentTurnLocalStartedAt(timing, 3_600_000 + 60_000)).toBe(3_600_000 + 57_500)
  })

  it('never moves the anchor forward when the row predates its own start', () => {
    expect(
      structuredAgentTurnLocalStartedAt(
        { state: 'running', startedAt: 50_000, observedAt: 40_000 },
        100
      )
    ).toBe(100)
  })
})

describe('host-settled turns override local observation', () => {
  it('wins per turn and leaves locally observed turns from an older host intact', () => {
    const settled = selectStructuredAgentSettledTurns([
      user('u1'),
      lifecycle('t1', { state: 'completed', startedAt: 10_000, completedAt: 197_000 })
    ])
    const statuses = selectNativeChatTurnStatuses(
      { u0: { startedAt: 500, workedSeconds: 4 }, u1: { startedAt: 900, workedSeconds: 2 } },
      {
        activeTurnKey: 'u1',
        isWorking: false,
        hasCurrentTurnResponse: true,
        settledByTurn: settled
      }
    )
    expect(statuses.completedByTurn.u1?.workedSeconds).toBe(187)
    expect(statuses.completedByTurn.u0?.workedSeconds).toBe(4)
    expect(statuses.active?.workedSeconds).toBe(187)
  })
})

describe('selectStructuredAgentRunningTurnTiming', () => {
  it('finds the live turn by id and returns null for an older host row without a start', () => {
    const items = [user('u1'), lifecycle('t1', { state: 'running', startedAt: 7_000 }, 7_250)]
    expect(selectStructuredAgentRunningTurnTiming(items, 't1')).toEqual({
      state: 'running',
      startedAt: 7_000,
      observedAt: 7_250
    })
    expect(selectStructuredAgentRunningTurnTiming(items, 'other')).toBeNull()
    expect(
      selectStructuredAgentRunningTurnTiming([user('u2'), lifecycle('t2', {})], 't2')
    ).toBeNull()
  })
})

describe('explicit user-item attribution', () => {
  const submission = (clientMessageId: string, providerItemId: string | null) => ({
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted' as const,
    providerItemId,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2
  })

  it('resolves a submission through its provider alias instead of journal order', () => {
    const items = [
      user('orca:first'),
      user('orca:second'),
      lifecycle('t1', {
        state: 'completed',
        userItemId: 'codex:thread:t1:0',
        startedAt: 1_000,
        completedAt: 5_000
      })
    ]
    const timings = selectStructuredAgentTurnTimings(items, [
      submission('first', 'codex:thread:t1:0'),
      submission('second', null)
    ])
    expect([...timings.keys()]).toEqual(['orca:first'])
  })

  it('uses the key directly when the user item is journaled under it', () => {
    const items = [
      user('claude:s:u1'),
      lifecycle('u1', {
        state: 'completed',
        userItemId: 'claude:s:u1',
        startedAt: 1_000,
        completedAt: 2_000
      })
    ]
    expect([...selectStructuredAgentTurnTimings(items).keys()]).toEqual(['claude:s:u1'])
  })

  it('attributes nothing when a keyed row names a user item nobody journaled', () => {
    const items = [
      user('orca:first'),
      lifecycle('auto', {
        state: 'completed',
        userItemId: 'codex:thread:auto:0',
        startedAt: 1_000,
        completedAt: 2_000
      })
    ]
    expect(selectStructuredAgentTurnTimings(items).size).toBe(0)
  })

  it('falls back to journal order only for rows without a key (older hosts)', () => {
    const items = [
      user('orca:first'),
      lifecycle('t1', { state: 'completed', startedAt: 1_000, completedAt: 2_000 })
    ]
    expect([...selectStructuredAgentTurnTimings(items).keys()]).toEqual(['orca:first'])
  })
})

describe('provider-measured duration', () => {
  it('outranks the host interval and floors to seconds', () => {
    expect(
      completedStructuredAgentTurnSeconds({
        state: 'completed',
        startedAt: 1_000,
        completedAt: 9_999,
        durationMs: 7_172,
        observedAt: 1_000
      })
    ).toBe(7)
  })

  it('is ignored while the turn is not settled', () => {
    expect(
      completedStructuredAgentTurnSeconds({
        state: 'running',
        startedAt: 1_000,
        durationMs: 7_172,
        observedAt: 1_000
      })
    ).toBeNull()
  })
})

describe('coalesced sends and canonical rows', () => {
  const accepted = (clientMessageId: string, providerItemId: string) => ({
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted' as const,
    providerItemId,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2
  })

  it('gives a turn shared by two accepted sends to the prompt that opened it', () => {
    const items = [
      user('orca:first'),
      user('orca:second'),
      lifecycle('t1', {
        state: 'completed',
        userItemId: 'codex:thread:t1:0',
        startedAt: 1_000,
        completedAt: 5_000
      })
    ]
    const timings = selectStructuredAgentTurnTimings(items, [
      accepted('first', 'codex:thread:t1:0'),
      accepted('second', 'codex:thread:t1:0')
    ])
    expect([...timings.keys()]).toEqual(['orca:first'])
  })

  it('reads a canonical turn item exactly like the legacy carrier', () => {
    sequence += 1
    const canonical: AgentJournalRenderItem = {
      itemId: 'legacy:codex:s:turn-lifecycle%3At9',
      revision: 2,
      sequence,
      observedAt: 1_000,
      body: {
        kind: 'turn',
        turnId: 't9',
        state: 'completed',
        userItemId: 'orca:u9',
        startedAt: 1_000,
        completedAt: 9_000,
        durationMs: 7_172
      }
    }
    const timings = selectStructuredAgentTurnTimings([user('orca:u9'), canonical])
    expect(timings.get('orca:u9')).toMatchObject({ state: 'completed', durationMs: 7_172 })
    expect(selectStructuredAgentSettledTurns([user('orca:u9'), canonical]).get('orca:u9')).toEqual({
      startedAt: 1_000,
      workedSeconds: 7
    })
    expect(selectStructuredAgentRunningTurnTiming([canonical], 't9')?.startedAt).toBe(1_000)
  })
})

describe('structuredAgentTurnLocalStartedAt with the host clock', () => {
  it('counts a mid-turn attach from the real start, not from first sight', () => {
    const timing = { state: 'running' as const, startedAt: 50_000, observedAt: 50_000 }
    // Host says the turn has run 40s; client clock is arbitrary.
    expect(structuredAgentTurnLocalStartedAt(timing, 3_600_000, 90_000)).toBe(3_600_000 - 40_000)
    expect(structuredAgentTurnLocalStartedAt(timing, 3_600_000, 40_000)).toBe(3_600_000)
  })
})
