import { describe, expect, it } from 'vitest'
import {
  failedAcquisitionDeathEvidence,
  type AgentSessionAcquisitionExitProof
} from './agent-session-failed-acquisition'
import type { AgentSessionOwnerProbe } from './agent-session-lease-adjudication'
import {
  agentSessionLeaseAdmitsWriter,
  agentSessionLeaseFreeEvidence,
  agentSessionLeaseIsFree,
  agentSessionLeaseOwnerVerdict,
  deriveAgentSessionLeaseState,
  type AgentSessionHostProof,
  type AgentSessionOwnerEvidence
} from './agent-session-lease-state'
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

function proof(owner: AgentSessionOwnerEvidence, fence = 7, attemptInFlight = false) {
  return { fence, attemptInFlight, owner } satisfies AgentSessionHostProof
}

const probed = (probe: AgentSessionOwnerProbe): AgentSessionOwnerEvidence => ({
  kind: 'probed',
  probe
})
const WATCHED: AgentSessionOwnerEvidence = { kind: 'watched-exit', observedAt: 900, reason: null }
const PID_ABSENT = probed({ outcome: 'pid-absent' })
const ALIVE = probed({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
const INDETERMINATE = probed({ outcome: 'indeterminate', reason: 'owner on another host' })
const RESERVED = {
  ownerProcess: null,
  claimStatus: 'reserved',
  handoffStage: 'new-owner-proving',
  handoffOperationId: 'op-1'
} as const

describe('lease state derived from host proof', () => {
  it('frees a stored live lease whose owner this host watched exit or probed dead', () => {
    // The stranded case: the exit-time release write failed, the stored claim still says live.
    expect(deriveAgentSessionLeaseState(lease(), proof(WATCHED))).toEqual({
      state: 'free',
      basis: WATCHED
    })
    expect(deriveAgentSessionLeaseState(lease(), proof(PID_ABSENT)).state).toBe('free')
  })

  it('admits a writer only for the owner this host runs', () => {
    expect(
      agentSessionLeaseAdmitsWriter(deriveAgentSessionLeaseState(lease(), proof({ kind: 'runs' })))
    ).toBe(true)
    expect(agentSessionLeaseAdmitsWriter(deriveAgentSessionLeaseState(lease(), proof(ALIVE)))).toBe(
      false
    )
    expect(agentSessionLeaseAdmitsWriter(deriveAgentSessionLeaseState(lease(), null))).toBe(false)
  })

  it.each([
    [
      'conflicted, even with proof of death',
      lease({ claimStatus: 'conflicted' }),
      PID_ABSENT,
      'conflicted'
    ],
    [
      'unreconciled, even with proof of death',
      lease({ unreconciled: true }),
      WATCHED,
      'reconciling'
    ],
    [
      'recovering, even with proof of death',
      lease({ handoffStage: 'recovering' }),
      PID_ABSENT,
      'recovering'
    ],
    ['proven alive', lease(), ALIVE, 'held'],
    ['unverifiable, including an owner on another host', lease(), INDETERMINATE, 'unverifiable'],
    ['nothing proven at all', lease(), { kind: 'none' }, 'unverifiable'],
    ['a reservation nothing proves unused', lease(RESERVED), INDETERMINATE, 'unverifiable']
  ] as const)('never frees a lease that is %s', (_label, stored, owner, expected) => {
    const state = deriveAgentSessionLeaseState(stored, proof(owner))
    expect(state.state).toBe(expected)
    expect(agentSessionLeaseIsFree(state)).toBe(false)
  })

  it.each([
    ['unreconciled', lease({ unreconciled: true })],
    ['mid-handoff', lease({ handoffStage: 'new-owner-proving' })],
    ['reserved', lease({ claimStatus: 'reserved' })],
    ['recording no process', lease({ ownerProcess: null })],
    ['recovering', lease({ handoffStage: 'recovering' })]
  ] as const)('never admits the child this host runs as a writer while %s', (_label, stored) => {
    expect(
      agentSessionLeaseAdmitsWriter(deriveAgentSessionLeaseState(stored, proof({ kind: 'runs' })))
    ).toBe(false)
  })

  it('ignores proof gathered at another fence', () => {
    expect(deriveAgentSessionLeaseState(lease(), proof(WATCHED, 6)).state).toBe('unverifiable')
    expect(deriveAgentSessionLeaseState(lease(), proof({ kind: 'runs' }, 8)).state).toBe(
      'unverifiable'
    )
  })

  it("frees an abandoned reservation only on the token scan's proof", () => {
    expect(
      deriveAgentSessionLeaseState(
        lease(RESERVED),
        proof(probed({ outcome: 'reservation-unused' }))
      ).state
    ).toBe('free')
    expect(
      deriveAgentSessionLeaseState(lease({ ...RESERVED, ownerProcess: OWNER }), proof(PID_ABSENT))
        .state
    ).toBe('free')
  })

  it('reads an acquisition this host has in flight as acquiring, never unverifiable', () => {
    for (const stored of [lease(), lease(RESERVED), lease({ claimStatus: 'released' })]) {
      const state = deriveAgentSessionLeaseState(stored, proof({ kind: 'none' }, 7, true))
      expect(state).toEqual({ state: 'acquiring' })
      expect(agentSessionLeaseOwnerVerdict(stored, state)).toBe('live')
    }
  })

  it('trusts a stored release only in the clean shape restart adjudication calls free', () => {
    for (const leftover of [{ reservedSpawnToken: null }, { ownerProcess: null }]) {
      const stored = lease({ claimStatus: 'released', ...leftover })
      expect(deriveAgentSessionLeaseState(stored, proof(INDETERMINATE)).state).toBe('unverifiable')
      expect(deriveAgentSessionLeaseState(stored, null).state).not.toBe('free')
    }
    const recordedOwner = lease({ claimStatus: 'released', reservedSpawnToken: null })
    expect(deriveAgentSessionLeaseState(recordedOwner, proof(ALIVE)).state).toBe('held')
  })

  it('reads a clean release as free and exited before restart reconciliation lands', () => {
    const evidence = { kind: 'pid-absent', detail: 'gone', observedAt: 900, ownerFence: 6 } as const
    const released = lease({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      unreconciled: true,
      deathEvidence: evidence
    })
    const state = deriveAgentSessionLeaseState(released, null)
    expect(state).toEqual({ state: 'free', basis: { kind: 'stored' } })
    expect(agentSessionLeaseOwnerVerdict(released, state)).toBe('exited')
    expect(
      deriveAgentSessionLeaseState(lease({ claimStatus: 'released', unreconciled: true }), null)
        .state
    ).toBe('reconciling')
  })

  it('keeps a stored release free with whatever evidence it wrote', () => {
    const released = lease({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null
    })
    const state = deriveAgentSessionLeaseState(released, null)
    expect(state.state).toBe('free')
    // Recovery released it without proof: free to acquire, but nothing says the owner exited.
    expect(agentSessionLeaseOwnerVerdict(released, state)).toBe('unverifiable')
  })
})

describe('owner verdict and evidence', () => {
  it('answers exited for a derived free lease and records what the missed release would have', () => {
    const state = deriveAgentSessionLeaseState(lease(), proof({ ...WATCHED, reason: 'crashed' }))
    expect(agentSessionLeaseOwnerVerdict(lease(), state)).toBe('exited')
    expect(
      state.state === 'free' && agentSessionLeaseFreeEvidence(lease(), state.basis, 1_000)
    ).toEqual({
      kind: 'exit-observed',
      detail: 'crashed',
      observedAt: 900,
      ownerFence: 7
    })
  })

  it('bounds a probed death by the last renewal', () => {
    const state = deriveAgentSessionLeaseState(lease(), proof(PID_ABSENT))
    expect(
      state.state === 'free' && agentSessionLeaseFreeEvidence(lease(), state.basis, 2_000)
    ).toEqual({
      kind: 'pid-absent',
      detail: 'recorded pid absent on host',
      observedAt: 2_000,
      ownerFence: 7,
      lastProvenAliveAt: 500
    })
  })

  it('answers unverifiable, never live, for a stored live claim nothing proves', () => {
    expect(
      agentSessionLeaseOwnerVerdict(lease(), deriveAgentSessionLeaseState(lease(), null))
    ).toBe('unverifiable')
  })
})

describe("this host's own failed attempt whose settlement never landed", () => {
  const ATTEMPT = { spawnToken: 'spawn-a', operationId: 'op-1' }
  const RESERVATION = lease({ ...RESERVED, reservedSpawnToken: 'spawn-a' })
  const failed = (exitProof: AgentSessionAcquisitionExitProof): AgentSessionOwnerEvidence => ({
    kind: 'failed-acquisition',
    ...ATTEMPT,
    exitProof,
    observedAt: 900
  })

  it.each(['exit-proven', 'root-exit-observed', 'processless'] as const)(
    'frees its reservation as the %s settlement would have, with that evidence',
    (exitProof) => {
      const state = deriveAgentSessionLeaseState(RESERVATION, proof(failed(exitProof)))
      expect(state).toEqual({ state: 'free', basis: failed(exitProof) })
      expect(agentSessionLeaseOwnerVerdict(RESERVATION, state)).toBe('exited')
      expect(
        state.state === 'free' && agentSessionLeaseFreeEvidence(RESERVATION, state.basis, 2_000)
      ).toEqual(failedAcquisitionDeathEvidence(exitProof, 900, 7))
    }
  )

  it('frees an unrecorded spawn whose exit went unproven, as its settlement does, claiming no exit', () => {
    // Claude on an unwritable store: the identity commit and the close's handle write both fail.
    const state = deriveAgentSessionLeaseState(RESERVATION, proof(failed('unproven')))
    expect(state).toEqual({ state: 'free', basis: failed('unproven') })
    expect(agentSessionLeaseOwnerVerdict(RESERVATION, state)).toBe('unverifiable')
    expect(
      state.state === 'free' && agentSessionLeaseFreeEvidence(RESERVATION, state.basis, 2_000)
    ).toBeNull()
  })

  it('frees a recorded owner only when the attempt proved its exit, else reads it recovering', () => {
    const spawned = lease({ ...RESERVED, ownerProcess: OWNER })
    expect(deriveAgentSessionLeaseState(spawned, proof(failed('exit-proven'))).state).toBe('free')
    // Where its settlement would have parked it, for recovery to conclude about.
    expect(deriveAgentSessionLeaseState(spawned, proof(failed('unproven'))).state).toBe(
      'recovering'
    )
  })

  it.each([
    [
      'its recorded owner went unproven',
      lease({ ...RESERVED, ownerProcess: OWNER }),
      failed('unproven'),
      7
    ],
    ['the proof is for another fence', RESERVATION, failed('exit-proven'), 6],
    [
      'another attempt holds the reservation',
      lease({ ...RESERVED, handoffOperationId: 'op-2' }),
      failed('exit-proven'),
      7
    ],
    [
      'another token was reserved',
      lease({ ...RESERVED, reservedSpawnToken: 'spawn-b' }),
      failed('exit-proven'),
      7
    ],
    [
      'recovery already holds it',
      lease({ ...RESERVED, handoffStage: 'recovering' }),
      failed('exit-proven'),
      7
    ]
  ] as const)('never frees it when %s', (_label, stored, owner, fence) => {
    expect(agentSessionLeaseIsFree(deriveAgentSessionLeaseState(stored, proof(owner, fence)))).toBe(
      false
    )
  })
})
