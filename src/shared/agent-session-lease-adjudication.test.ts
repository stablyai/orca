import { describe, expect, it } from 'vitest'
import {
  adjudicateAgentSessionRestart,
  agentSessionLeaseAdmitsWriter,
  classifyObservedAgentSessionSpawnToken,
  evaluateAgentSessionAcquisition,
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from './agent-session-lease-adjudication'
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
    journalCheckpoint: null,
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

describe('proof classification', () => {
  it('treats a pid match with nothing PID-reuse-safe as no proof at all', () => {
    // A bare pid match is exactly the case that mints a second writer after pid reuse.
    expect(isProvenAliveProbe({ outcome: 'identity-matched', matchedOn: [] })).toBe(false)
    expect(isProvenAliveProbe(MATCHED)).toBe(true)
    expect(isProvenDeadProbe(INDETERMINATE)).toBe(false)
    expect(isProvenAliveProbe(INDETERMINATE)).toBe(false)
  })

  it.each([
    ['exit-observed', { outcome: 'exit-observed' } as AgentSessionOwnerProbe],
    ['pid-absent', { outcome: 'pid-absent' } as AgentSessionOwnerProbe],
    [
      'identity-mismatch',
      { outcome: 'identity-mismatch', field: 'spawn-token' } as AgentSessionOwnerProbe
    ]
  ])('accepts %s as proof of death', (_name, probe) => {
    expect(isProvenDeadProbe(probe)).toBe(true)
  })

  it('never counts a reservation probe or an indeterminate answer as death', () => {
    expect(isProvenDeadProbe({ outcome: 'reservation-unused' })).toBe(false)
    expect(isProvenDeadProbe(INDETERMINATE)).toBe(false)
  })
})

describe('acquisition compare-and-swap', () => {
  it('refuses a stale fence and grants at exactly fence + 1', () => {
    const held = lease({ ownerProcess: null, claimStatus: 'released', reservedSpawnToken: null })
    expect(
      evaluateAgentSessionAcquisition({
        lease: held,
        expectedFence: held.runtimeFence - 1,
        handoffOperationId: null,
        probe: MATCHED
      })
    ).toEqual({ decision: 'refused', code: 'agent_session_checkpoint_stale' })
    expect(acquire(held, MATCHED)).toEqual({ decision: 'granted', nextFence: 8 })
  })

  it('refuses the loser of a concurrent swap: only one caller sees the pre-state fence', () => {
    const before = lease({ ownerProcess: null, claimStatus: 'released', reservedSpawnToken: null })
    const winner = acquire(before, MATCHED)
    expect(winner).toEqual({ decision: 'granted', nextFence: 8 })
    // The loser still holds the pre-swap fence, which is no longer current.
    const after = lease({ ...before, runtimeFence: 8, claimStatus: 'reserved' })
    expect(
      evaluateAgentSessionAcquisition({
        lease: after,
        expectedFence: 7,
        handoffOperationId: null,
        probe: MATCHED
      })
    ).toEqual({ decision: 'refused', code: 'agent_session_checkpoint_stale' })
  })

  it('never grants a second owner on expiry alone', () => {
    // The recorded owner is long past its deadline; nothing here may consult that deadline.
    const expired = lease({ leaseDeadlineAt: 1, lastRenewedAt: 1 })
    expect(acquire(expired, INDETERMINATE)).toEqual({
      decision: 'refused',
      code: 'agent_session_ownership_unknown'
    })
    expect(acquire(expired, MATCHED)).toEqual({
      decision: 'refused',
      code: 'agent_session_conflict'
    })
    expect(acquire(expired, { outcome: 'pid-absent' })).toEqual({
      decision: 'granted',
      nextFence: 8
    })
  })

  it('refuses while unreconciled even with proof the owner is dead', () => {
    expect(acquire(lease({ unreconciled: true }), { outcome: 'pid-absent' })).toEqual({
      decision: 'refused',
      code: 'execution_owner_reconciling'
    })
  })

  it('keeps a conflicted claim conflicted regardless of proof', () => {
    expect(acquire(lease({ claimStatus: 'conflicted' }), { outcome: 'exit-observed' })).toEqual({
      decision: 'refused',
      code: 'agent_session_conflict'
    })
  })

  it.each([
    ['recovering', 'agent_session_ownership_unknown'],
    ['manual-recovery', 'agent_session_ownership_unknown'],
    ['preparing', 'agent_session_conflict']
  ] as const)('refuses acquisition in stage %s', (handoffStage, code) => {
    expect(acquire(lease({ handoffStage }), { outcome: 'pid-absent' })).toEqual({
      decision: 'refused',
      code
    })
  })

  it.each(['old-owner-stopped', 'new-owner-proving'] as const)(
    'refuses a different handoff operation and replays the matching one at %s',
    (handoffStage) => {
      const mid = lease({
        handoffStage,
        handoffOperationId: 'op-1',
        ownerProcess: null,
        claimStatus: 'reserved'
      })
      expect(acquire(mid, { outcome: 'reservation-unused' }, 'op-2')).toEqual({
        decision: 'refused',
        code: 'agent_session_operation_conflict'
      })
      expect(acquire(mid, { outcome: 'reservation-unused' }, 'op-1')).toEqual({
        decision: 'retry-reservation',
        fence: 7
      })
    }
  )

  it('refuses a reservation whose spawn may have won the race with the crash', () => {
    const reserved = lease({ ownerProcess: null, claimStatus: 'reserved', handoffStage: null })
    expect(acquire(reserved, INDETERMINATE)).toEqual({
      decision: 'refused',
      code: 'agent_session_ownership_unknown'
    })
    expect(acquire(reserved, { outcome: 'reservation-unused' })).toEqual({
      decision: 'granted',
      nextFence: 8
    })
  })
})

describe('restart reconciliation', () => {
  it('re-adopts a proven-live TUI owner without moving the fence', () => {
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ runtimeKind: 'tui' }),
        probe: MATCHED,
        observedAt: 9_000
      })
    ).toEqual({ disposition: 'readopt' })
  })

  it('routes a surviving native owner to recovery instead of readopting a dead transport', () => {
    // The native child's stdio belonged to the runtime that died; readoption would extend
    // a lease no process can drive. Recovery stops the orphan and respawns at fence + 1.
    expect(
      adjudicateAgentSessionRestart({ lease: lease(), probe: MATCHED, observedAt: 9_000 })
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
      evidence: {
        kind: 'identity-mismatch',
        detail: 'mismatched process-start-time',
        observedAt: 9_000
      }
    })
  })

  it('keeps re-asking about an unverifiable owner instead of evicting it', () => {
    // A recorded exact identity can still be probed later; manual recovery is reserved
    // for leases that name no process at all.
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ leaseDeadlineAt: 1 }),
        probe: INDETERMINATE,
        observedAt: 9_000
      })
    ).toEqual({ disposition: 'recovering', stage: 'recovering', reason: 'no answer' })
  })

  it('keeps a pre-restart conflict conflicted while its owner cannot be proven gone', () => {
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ claimStatus: 'conflicted' }),
        probe: INDETERMINATE,
        observedAt: 9_000
      })
    ).toEqual({ disposition: 'conflicted', reason: 'claim conflicted before restart' })
  })

  it('keeps a conflict conflicted when it names no process to prove anything about', () => {
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ claimStatus: 'conflicted', ownerProcess: null }),
        probe: { outcome: 'pid-absent' },
        observedAt: 9_000
      })
    ).toEqual({ disposition: 'conflicted', reason: 'claim conflicted before restart' })
  })

  it('frees a conflict whose named owner is proven gone', () => {
    // Why: the conflict protects one specific process. Once that process is proven gone there is
    // no claimant left, and a conflict with no exit is a session nobody can ever open again.
    expect(
      adjudicateAgentSessionRestart({
        lease: lease({ claimStatus: 'conflicted' }),
        probe: { outcome: 'pid-absent' },
        observedAt: 9_000
      })
    ).toEqual({
      disposition: 'evicted',
      nextFence: 8,
      evidence: { kind: 'pid-absent', detail: 'recorded pid absent on host', observedAt: 9_000 }
    })
  })

  it('frees a lease that names neither an owner nor a reservation, without moving the fence', () => {
    // Why: an evicted lease has no owner and no token, so a restart has nothing to probe.
    // Calling that an unproven reservation re-latched every released record on every boot.
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

  it('does not infer an ownerless native reservation is unused from restart alone', () => {
    const reserved = lease({ ownerProcess: null, claimStatus: 'reserved' })
    expect(
      adjudicateAgentSessionRestart({ lease: reserved, probe: INDETERMINATE, observedAt: 9_000 })
    ).toEqual({
      disposition: 'recovering',
      stage: 'manual-recovery',
      reason: 'reservation with no proven process'
    })
  })

  it('frees a TUI reservation only when a probe proves nothing ever spawned', () => {
    // A TUI child lives in a terminal that outlives the runtime, so absence needs proof.
    const reserved = lease({ ownerProcess: null, claimStatus: 'reserved', runtimeKind: 'tui' })
    expect(
      adjudicateAgentSessionRestart({
        lease: reserved,
        probe: { outcome: 'reservation-unused' },
        observedAt: 9_000
      })
    ).toMatchObject({ disposition: 'evicted', nextFence: 8 })
    expect(
      adjudicateAgentSessionRestart({ lease: reserved, probe: INDETERMINATE, observedAt: 9_000 })
    ).toMatchObject({ disposition: 'recovering', stage: 'manual-recovery' })
  })
})

describe('writer admission and orphan spawn tokens', () => {
  it('admits a writer only when reconciled, settled, live, and holding a process', () => {
    expect(agentSessionLeaseAdmitsWriter(lease())).toBe(true)
    expect(agentSessionLeaseAdmitsWriter(lease({ unreconciled: true }))).toBe(false)
    expect(agentSessionLeaseAdmitsWriter(lease({ handoffStage: 'new-owner-proving' }))).toBe(false)
    expect(agentSessionLeaseAdmitsWriter(lease({ claimStatus: 'reserved' }))).toBe(false)
    expect(agentSessionLeaseAdmitsWriter(lease({ ownerProcess: null }))).toBe(false)
  })

  it('calls a spawn token with no matching lease an orphan', () => {
    const leases = [lease(), lease({ sessionId: 'session-beta-1', reservedSpawnToken: 'spawn-b' })]
    expect(classifyObservedAgentSessionSpawnToken({ spawnToken: 'spawn-a', leases })).toBe('owned')
    expect(classifyObservedAgentSessionSpawnToken({ spawnToken: 'spawn-b', leases })).toBe('owned')
    expect(classifyObservedAgentSessionSpawnToken({ spawnToken: 'spawn-z', leases })).toBe('orphan')
  })

  it('still recognises an owner whose reservation token was cleared after proving', () => {
    const proved = lease({ reservedSpawnToken: null })
    expect(
      classifyObservedAgentSessionSpawnToken({ spawnToken: 'spawn-a', leases: [proved] })
    ).toBe('owned')
  })
})
