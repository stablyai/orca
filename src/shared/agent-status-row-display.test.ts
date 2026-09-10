import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-freshness'
import {
  resolveAgentRowDisplayState,
  resolveDecayedAgentRowState,
  type AgentRowDisplayInput
} from './agent-status-row-display'

const STALE = AGENT_STATUS_STALE_AFTER_MS
const OBSERVED_AT = 1_000_000

function row(overrides: Partial<AgentRowDisplayInput> = {}): AgentRowDisplayInput {
  return { state: 'working', updatedAt: OBSERVED_AT, ...overrides }
}

describe('resolveAgentRowDisplayState', () => {
  it('keeps a fresh row on its reported state', () => {
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      expect(resolveAgentRowDisplayState(row({ state }), OBSERVED_AT + 1)).toBe(state)
    }
  })

  it('holds the state exactly at the window and decays strictly past it', () => {
    expect(resolveAgentRowDisplayState(row(), OBSERVED_AT + STALE)).toBe('working')
    expect(resolveAgentRowDisplayState(row(), OBSERVED_AT + STALE + 1)).toBe('idle')
  })

  it('splits the decay destination on live-PTY evidence', () => {
    const now = OBSERVED_AT + STALE + 1
    expect(resolveAgentRowDisplayState(row(), now, { hasLivePty: true })).toBe('unverifiable')
    expect(resolveAgentRowDisplayState(row(), now, { hasLivePty: false })).toBe('idle')
    // A reader holding no liveness evidence at all gets the honest destination, not `unverifiable`.
    expect(resolveAgentRowDisplayState(row(), now)).toBe('idle')
  })

  it('never decays done, however old', () => {
    expect(
      resolveAgentRowDisplayState(row({ state: 'done' }), OBSERVED_AT + STALE * 100, {
        hasLivePty: true
      })
    ).toBe('done')
  })

  it('exempts a host-owned structured row from the window', () => {
    const ancient = OBSERVED_AT + STALE * 10
    expect(resolveAgentRowDisplayState(row({ structuredHostOwned: true }), ancient)).toBe('working')
    expect(resolveAgentRowDisplayState(row(), ancient)).toBe('idle')
  })

  it('never treats a hydrated unconfirmed row as fresh, however recent', () => {
    expect(resolveAgentRowDisplayState(row({ restoredUnconfirmed: true }), OBSERVED_AT + 1)).toBe(
      'idle'
    )
    // …and it decays to idle even behind a live PTY: there is no "since we last heard" to report.
    expect(
      resolveAgentRowDisplayState(row({ restoredUnconfirmed: true }), OBSERVED_AT + 1, {
        hasLivePty: true
      })
    ).toBe('idle')
  })

  it('measures against the evidence clock, not the delivery clock', () => {
    // A relay reconnect restamps `updatedAt`; the row is still stale on the evidence it carries.
    const replayed = row({ updatedAt: OBSERVED_AT + STALE, evidenceObservedAt: OBSERVED_AT })
    expect(resolveAgentRowDisplayState(replayed, OBSERVED_AT + STALE + 1)).toBe('idle')
    // A mirrored row decays against this replica's own receipt, outranking the host's stamps.
    const mirrored = row({
      updatedAt: OBSERVED_AT,
      evidenceObservedAt: OBSERVED_AT,
      mirroredEvidenceReceivedAt: OBSERVED_AT + STALE
    })
    expect(resolveAgentRowDisplayState(mirrored, OBSERVED_AT + STALE + 1)).toBe('working')
  })

  it('falls back to updatedAt when a row carries no evidence stamps', () => {
    // The `worktree ps` wire row has neither field, and an old host sends no structuredHostOwned;
    // absence must mean "use the ordinary window", never "fresh".
    const wireRow: AgentRowDisplayInput = { state: 'working', updatedAt: OBSERVED_AT }
    expect(resolveAgentRowDisplayState(wireRow, OBSERVED_AT + STALE)).toBe('working')
    expect(resolveAgentRowDisplayState(wireRow, OBSERVED_AT + STALE + 1)).toBe('idle')
  })

  it('honours a caller-supplied window', () => {
    expect(resolveAgentRowDisplayState(row(), OBSERVED_AT + 50, { staleAfterMs: 100 })).toBe(
      'working'
    )
    expect(resolveAgentRowDisplayState(row(), OBSERVED_AT + 101, { staleAfterMs: 100 })).toBe(
      'idle'
    )
  })
})

describe('resolveDecayedAgentRowState', () => {
  it('reports unverifiable only for a live non-done pane Orca can still see', () => {
    expect(resolveDecayedAgentRowState({ state: 'working' }, true)).toBe('unverifiable')
    expect(resolveDecayedAgentRowState({ state: 'working' }, false)).toBe('idle')
    expect(resolveDecayedAgentRowState({ state: 'done' }, true)).toBe('idle')
    expect(resolveDecayedAgentRowState({ state: 'working', restoredUnconfirmed: true }, true)).toBe(
      'idle'
    )
  })
})
