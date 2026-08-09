import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload, AgentStatusState } from '../agent-status-types'
import { buildNotchSummary, isNotchIdle, isUnvisited, laneForState } from './notch-status-summary'

function payload(
  paneKey: string,
  state: AgentStatusState,
  overrides: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey,
    state,
    prompt: '',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: 1_000,
    ...overrides
  } as AgentStatusIpcPayload
}

const noAcks: Record<string, number> = {}

describe('laneForState', () => {
  it('maps every agent state onto the dashboard buckets', () => {
    expect(laneForState('working')).toBe('working')
    expect(laneForState('done')).toBe('done')
    expect(laneForState('blocked')).toBe('attention')
    expect(laneForState('waiting')).toBe('attention')
  })
})

describe('isUnvisited', () => {
  it('treats a never-acknowledged pane as unvisited', () => {
    expect(isUnvisited(1_000, undefined)).toBe(true)
  })

  it('treats an ack older than the state as unvisited', () => {
    expect(isUnvisited(2_000, 1_500)).toBe(true)
  })

  it('treats an ack at or after the state start as visited', () => {
    expect(isUnvisited(2_000, 2_000)).toBe(false)
    expect(isUnvisited(2_000, 2_500)).toBe(false)
  })
})

describe('buildNotchSummary', () => {
  it('counts each lane and collapses blocked and waiting together', () => {
    const summary = buildNotchSummary({
      snapshot: [
        payload('t1:a', 'working'),
        payload('t1:b', 'blocked'),
        payload('t1:c', 'waiting'),
        payload('t1:d', 'done')
      ],
      acknowledgedAtByPaneKey: noAcks
    })

    expect(summary.counts).toEqual({ working: 1, attention: 2, done: 1 })
    expect(summary.sessions).toHaveLength(4)
  })

  it('drops a done pane once it has been visited', () => {
    const snapshot = [payload('t1:a', 'done', { stateStartedAt: 5_000 })]

    expect(
      buildNotchSummary({ snapshot, acknowledgedAtByPaneKey: { 't1:a': 4_999 } }).counts.done
    ).toBe(1)
    expect(
      buildNotchSummary({ snapshot, acknowledgedAtByPaneKey: { 't1:a': 5_000 } }).counts.done
    ).toBe(0)
  })

  it('drops a visited done pane from the session list too, so bar and panel agree', () => {
    const summary = buildNotchSummary({
      snapshot: [payload('t1:a', 'done', { stateStartedAt: 5_000 })],
      acknowledgedAtByPaneKey: { 't1:a': 6_000 }
    })

    expect(summary.sessions).toEqual([])
    expect(isNotchIdle(summary)).toBe(true)
  })

  it('keeps a blocked pane counted even after the user visits it', () => {
    // Why: visiting a blocked pane doesn't answer the question — it still needs the user.
    const summary = buildNotchSummary({
      snapshot: [payload('t1:a', 'blocked', { stateStartedAt: 5_000 })],
      acknowledgedAtByPaneKey: { 't1:a': 9_000 }
    })

    expect(summary.counts.attention).toBe(1)
  })

  it('re-counts a done pane when the agent finishes a later turn', () => {
    const acknowledgedAtByPaneKey = { 't1:a': 5_000 }
    expect(
      buildNotchSummary({
        snapshot: [payload('t1:a', 'done', { stateStartedAt: 5_000 })],
        acknowledgedAtByPaneKey
      }).counts.done
    ).toBe(0)
    expect(
      buildNotchSummary({
        snapshot: [payload('t1:a', 'done', { stateStartedAt: 8_000 })],
        acknowledgedAtByPaneKey
      }).counts.done
    ).toBe(1)
  })

  it('ignores resume-identity-only payloads', () => {
    const summary = buildNotchSummary({
      snapshot: [payload('t1:a', 'working', { providerSessionOnly: true })],
      acknowledgedAtByPaneKey: noAcks
    })

    expect(summary.counts.working).toBe(0)
    expect(isNotchIdle(summary)).toBe(true)
  })

  it('never double-counts a duplicated pane key', () => {
    const summary = buildNotchSummary({
      snapshot: [payload('t1:a', 'working'), payload('t1:a', 'working')],
      acknowledgedAtByPaneKey: noAcks
    })

    expect(summary.counts.working).toBe(1)
  })

  it('orders attention before working before done', () => {
    const summary = buildNotchSummary({
      snapshot: [
        payload('t1:done', 'done'),
        payload('t1:working', 'working'),
        payload('t1:blocked', 'blocked')
      ],
      acknowledgedAtByPaneKey: noAcks
    })

    expect(summary.sessions.map((s) => s.lane)).toEqual(['attention', 'working', 'done'])
  })

  it('orders most recent first within a lane, breaking ties on pane key', () => {
    const summary = buildNotchSummary({
      snapshot: [
        payload('t1:b', 'working', { stateStartedAt: 100 }),
        payload('t1:a', 'working', { stateStartedAt: 100 }),
        payload('t1:c', 'working', { stateStartedAt: 900 })
      ],
      acknowledgedAtByPaneKey: noAcks
    })

    expect(summary.sessions.map((s) => s.paneKey)).toEqual(['t1:c', 't1:a', 't1:b'])
  })

  it('carries SSH attribution through to the session row', () => {
    const summary = buildNotchSummary({
      snapshot: [payload('t1:a', 'working', { connectionId: 'ssh-1', worktreeId: 'wt-9' })],
      acknowledgedAtByPaneKey: noAcks
    })

    expect(summary.sessions[0]).toMatchObject({ connectionId: 'ssh-1', worktreeId: 'wt-9' })
  })

  it('drops a working agent whose hooks went silent', () => {
    // Why: a SIGKILLed agent never sends `done`. Without decay the bar reports a phantom
    // working agent forever, while the sidebar and dashboard have long since retired it.
    const stale = payload('t1:a', 'working', { receivedAt: 0, stateStartedAt: 0 })

    expect(
      buildNotchSummary({ snapshot: [stale], acknowledgedAtByPaneKey: noAcks, now: 1_000 }).counts
        .working
    ).toBe(1)
    expect(
      buildNotchSummary({ snapshot: [stale], acknowledgedAtByPaneKey: noAcks, now: 31 * 60_000 })
        .counts.working
    ).toBe(0)
  })

  it('drops a stale blocked agent too', () => {
    const stale = payload('t1:a', 'blocked', { receivedAt: 0, stateStartedAt: 0 })

    expect(
      buildNotchSummary({ snapshot: [stale], acknowledgedAtByPaneKey: noAcks, now: 31 * 60_000 })
        .counts.attention
    ).toBe(0)
  })

  it('drops an unconfirmed hydrated row even when its timestamp is fresh', () => {
    // Why: hydrateLastStatusFromDisk marks restored non-done rows restoredUnconfirmed — the
    // turn may have ended while no receiver was up. Every other surface suppresses them.
    const hydrated = payload('t1:a', 'working', {
      receivedAt: 900,
      stateStartedAt: 900,
      restoredUnconfirmed: true
    })

    expect(
      buildNotchSummary({ snapshot: [hydrated], acknowledgedAtByPaneKey: noAcks, now: 1_000 })
        .counts.working
    ).toBe(0)
  })

  it('ignores a session-boundary done row, which is idle, not a completed turn', () => {
    // Why: Claude SessionStart (connect/resume/clear) lands as done + sessionBoundary. The
    // unvisited-gated green lane is an unread-completion surface, which must skip it.
    const boundary = payload('t1:a', 'done', { stateStartedAt: 5_000, sessionBoundary: true })

    const summary = buildNotchSummary({ snapshot: [boundary], acknowledgedAtByPaneKey: noAcks })
    expect(summary.counts.done).toBe(0)
    expect(summary.sessions).toEqual([])
  })

  it('keeps a done agent however old, since done is terminal not a heartbeat', () => {
    // Why: `done` means the turn finished; age doesn't make that untrue. It clears on visit.
    // stateStartedAt must be > 0: an unvisited row is ackAt < stateStartedAt, and a zero start
    // would read as already acknowledged.
    const old = payload('t1:a', 'done', { receivedAt: 0, stateStartedAt: 1_000 })

    expect(
      buildNotchSummary({
        snapshot: [old],
        acknowledgedAtByPaneKey: noAcks,
        now: 8 * 24 * 3_600_000
      }).counts.done
    ).toBe(1)
  })

  it('keeps a working agent that is still reporting', () => {
    const fresh = payload('t1:a', 'working', { receivedAt: 29 * 60_000, stateStartedAt: 0 })

    expect(
      buildNotchSummary({ snapshot: [fresh], acknowledgedAtByPaneKey: noAcks, now: 30 * 60_000 })
        .counts.working
    ).toBe(1)
  })

  it('drops a stale row from the session list, not just the count', () => {
    const stale = payload('t1:a', 'working', { receivedAt: 0, stateStartedAt: 0 })

    expect(
      buildNotchSummary({ snapshot: [stale], acknowledgedAtByPaneKey: noAcks, now: 31 * 60_000 })
        .sessions
    ).toEqual([])
  })

  it('reports idle for an empty snapshot', () => {
    const summary = buildNotchSummary({ snapshot: [], acknowledgedAtByPaneKey: noAcks })

    expect(isNotchIdle(summary)).toBe(true)
    expect(summary.counts).toEqual({ working: 0, attention: 0, done: 0 })
  })
})
