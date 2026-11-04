import { describe, expect, it } from 'vitest'
import {
  adjudicateAgentSessionRestart,
  evaluateAgentSessionAcquisition,
  type AgentSessionOwnerProbe
} from './agent-session-lease-adjudication'
import { normalizeLegacyHandoffLease } from './agent-session-legacy-handoff-lease'
import type { AgentSessionLease } from './agent-session-record'

const OWNER = {
  hostId: 'local',
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'spawn-a'
}

function lease(overrides: Partial<AgentSessionLease> = {}): AgentSessionLease {
  return {
    sessionId: 'session-alpha-1',
    runtimeKind: 'native',
    runtimeFence: 7,
    handoffStage: null,
    provenHandleLinkId: 'link-1',
    ownerProcess: OWNER,
    reservedSpawnToken: 'spawn-a',
    leaseDeadlineAt: 1_000,
    lastRenewedAt: 500,
    handoffOperationId: null,
    claimKeyId: 'key-1',
    claimStatus: 'live',
    unreconciled: false,
    deathEvidence: null,
    ...overrides
  }
}

const MATCHED: AgentSessionOwnerProbe = { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

function acquire(
  leaseState: AgentSessionLease,
  probe: AgentSessionOwnerProbe,
  handoffOperationId: string | null = null
) {
  return evaluateAgentSessionAcquisition({
    lease: leaseState,
    expectedFence: leaseState.runtimeFence,
    handoffOperationId,
    probe
  })
}

describe('acquisition compare-and-swap', () => {
  it('never grants a second owner on expiry alone', () => {
    // The recorded owner is long past its deadline; nothing here may consult that deadline.
    const expired = lease({ leaseDeadlineAt: 1, lastRenewedAt: 1 })
    expect(acquire(expired, INDETERMINATE)).toEqual({
      decision: 'refused',
      code: 'agent_session_ownership_unknown',
      details: { reason: 'ownerUnproven' }
    })
    expect(acquire(expired, MATCHED)).toEqual({
      decision: 'refused',
      code: 'agent_session_conflict',
      details: { reason: 'ownerAlive' }
    })
    expect(acquire(expired, { outcome: 'pid-absent' })).toEqual({
      decision: 'granted',
      nextFence: 8
    })
  })

  it('refuses while unreconciled even with proof the owner is dead', () => {
    expect(acquire(lease({ unreconciled: true }), { outcome: 'pid-absent' })).toEqual({
      decision: 'refused',
      code: 'execution_owner_reconciling',
      details: { reason: 'hostReconciling' }
    })
  })

  it('refuses a different acquisition operation and replays the matching one', () => {
    const mid = lease({
      handoffStage: 'new-owner-proving',
      handoffOperationId: 'op-1',
      ownerProcess: null,
      claimStatus: 'reserved'
    })
    expect(acquire(mid, { outcome: 'reservation-unused' }, 'op-2')).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_conflict',
      details: { reason: 'handoffInFlight' }
    })
    expect(acquire(mid, { outcome: 'reservation-unused' }, 'op-1')).toEqual({
      decision: 'retry-reservation',
      fence: 7
    })
  })

  it('refuses a reservation whose spawn may have won the race with the crash', () => {
    const reserved = lease({ ownerProcess: null, claimStatus: 'reserved', handoffStage: null })
    expect(acquire(reserved, INDETERMINATE)).toEqual({
      decision: 'refused',
      code: 'agent_session_ownership_unknown',
      details: { reason: 'ownerUnproven' }
    })
    expect(acquire(reserved, { outcome: 'reservation-unused' })).toEqual({
      decision: 'granted',
      nextFence: 8
    })
  })
})

describe('restart reconciliation', () => {
  it('keeps a surviving terminal owner an older build recorded conflicted; nothing re-adopts it', () => {
    const normalized = normalizeLegacyHandoffLease({ ...lease(), runtimeKind: 'tui' })
    expect(normalized).toMatchObject({ runtimeKind: 'native', claimStatus: 'conflicted' })
    expect(
      adjudicateAgentSessionRestart({
        lease: normalized,
        probe: MATCHED,
        observedAt: 9_000
      })
    ).toMatchObject({ disposition: 'recovering', stage: 'recovering' })
  })

  it('bumps the fence exactly once for a proven-dead owner and records the evidence', () => {
    const result = adjudicateAgentSessionRestart({
      lease: lease(),
      probe: { outcome: 'identity-mismatch', field: 'process-start-time' },
      observedAt: 9_000
    })
    expect(result).toEqual({
      disposition: 'evicted',
      nextFence: 8,
      // The death happened between the last renewal and the probe.
      evidence: {
        kind: 'identity-mismatch',
        detail: 'mismatched process-start-time',
        observedAt: 9_000,
        ownerFence: 7,
        lastProvenAliveAt: 500
      }
    })
  })

  it('never records the owner alive after the probe that found it gone', () => {
    // A clock stepped back across the restart would otherwise write an interval load rejects.
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ lastRenewedAt: 9_500 }),
        probe: { outcome: 'pid-absent' },
        observedAt: 9_000
      })
    ).toMatchObject({ evidence: { observedAt: 9_000, lastProvenAliveAt: 9_000 } })
  })

  it('re-adjudicates a claim an older record marked conflicted by the owner it names', () => {
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ claimStatus: 'conflicted' }),
        probe: INDETERMINATE,
        observedAt: 9_000
      })
    ).toEqual({ disposition: 'recovering', stage: 'recovering', reason: 'no answer' })
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ claimStatus: 'conflicted', ownerProcess: null }),
        probe: INDETERMINATE,
        observedAt: 9_000
      })
    ).toEqual({ disposition: 'evicted', nextFence: 8, evidence: null })
  })

  it('frees a lease that names neither an owner nor a reservation, without moving the fence', () => {
    // Evicted leases have neither owner nor token to probe; treating them as unproven reservations re-latches every released record.
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({
          ownerProcess: null,
          reservedSpawnToken: null,
          claimStatus: 'released',
          handoffStage: 'recovering'
        }),
        probe: INDETERMINATE,
        observedAt: 9_000
      })
    ).toEqual({ disposition: 'free', reason: 'lease has no owner and no reservation' })
  })

  it.each([null, 'recovering'] as const)(
    'releases an ownerless reservation at stage %s, with evidence only when a scan proved nothing spawned',
    (handoffStage) => {
      // Before identity is saved, a crashed child loses stdio and only a token scan can prove absence.
      const reserved = lease({ ownerProcess: null, claimStatus: 'reserved', handoffStage })
      expect(
        adjudicateAgentSessionRestart({ lease: reserved, probe: INDETERMINATE, observedAt: 9_000 })
      ).toEqual({ disposition: 'evicted', nextFence: 8, evidence: null })
      expect(
        adjudicateAgentSessionRestart({
          lease: reserved,
          probe: { outcome: 'reservation-unused' },
          observedAt: 9_000
        })
      ).toEqual({
        disposition: 'evicted',
        nextFence: 8,
        // The proof is about this reservation's own fence.
        evidence: {
          kind: 'pid-absent',
          detail: 'reservation never spawned',
          observedAt: 9_000,
          ownerFence: 7
        }
      })
    }
  )
})
