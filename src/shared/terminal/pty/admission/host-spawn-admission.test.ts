import { describe, expect, it } from 'vitest'
import {
  applySpawnAdmission,
  createSpawnAdmissionState,
  decideSpawnAdmission,
  resolveSpawnCharge,
  settleSpawnAdmission
} from './host-spawn-admission'
import {
  DEFAULT_SPAWN_ADMISSION_LIMITS as LIMITS,
  type AutomaticWorkMode,
  type HostPressureLevel,
  type SpawnRequestFacts
} from './spawn-admission-contract'

const NORMAL: AutomaticWorkMode = { kind: 'normal' }

function facts(overrides: Partial<SpawnRequestFacts> = {}): SpawnRequestFacts {
  return {
    clientId: 'client-a',
    declaredIntent: null,
    hasAgentSessionClaim: true,
    hasHistorySeed: true,
    deadlineAt: Number.POSITIVE_INFINITY,
    ...overrides
  }
}

function decide(
  state: ReturnType<typeof createSpawnAdmissionState>,
  f: SpawnRequestFacts,
  now: number,
  pressure: HostPressureLevel = 'ok',
  mode: AutomaticWorkMode = NORMAL
) {
  const charge = resolveSpawnCharge(state, f, LIMITS, now)
  return decideSpawnAdmission({ state, facts: f, charge, pressure, mode, limits: LIMITS, now })
}

describe('resolveSpawnCharge', () => {
  it('infers automatic restore for an old caller from an agent claim, seeded or not', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    expect(resolveSpawnCharge(state, facts(), LIMITS, 0)).toBe('automatic')
    // A remote client's resume: fresh terminal id, claim, no history seed.
    expect(resolveSpawnCharge(state, facts({ hasHistorySeed: false }), LIMITS, 0)).toBe('automatic')
    expect(resolveSpawnCharge(state, facts({ hasAgentSessionClaim: false }), LIMITS, 0)).toBe(
      'interactive'
    )
  })

  it('charges a declared user resume as automatic once its per-client bucket is empty', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    const f = facts({ declaredIntent: 'user-resume' })
    for (let i = 0; i < LIMITS.userResumeBucketCapacity; i++) {
      expect(resolveSpawnCharge(state, f, LIMITS, 0)).toBe('user')
      applySpawnAdmission(state, f, 'user', LIMITS, 0)
      settleSpawnAdmission(state, 'user', true)
    }
    expect(resolveSpawnCharge(state, f, LIMITS, 0)).toBe('automatic')
    expect(
      resolveSpawnCharge(state, facts({ declaredIntent: 'user-resume', clientId: 'b' }), LIMITS, 0)
    ).toBe('user')
    expect(resolveSpawnCharge(state, f, LIMITS, LIMITS.userResumeBucketWindowMs)).toBe('user')
  })

  it('does not let a claimed agent resume declare itself interactive', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    expect(resolveSpawnCharge(state, facts({ declaredIntent: 'interactive' }), LIMITS, 0)).toBe(
      'automatic'
    )
    expect(
      resolveSpawnCharge(
        state,
        facts({ declaredIntent: 'interactive', hasAgentSessionClaim: false }),
        LIMITS,
        0
      )
    ).toBe('interactive')
  })
})

describe('decideSpawnAdmission', () => {
  it('always admits interactive forks, even under critical pressure and pause', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    const f = facts({ declaredIntent: 'interactive', hasAgentSessionClaim: false })
    expect(
      decide(state, f, 0, 'critical', { kind: 'paused', reason: 'operator', since: 0 })
    ).toEqual({ kind: 'admit', charge: 'interactive' })
  })

  it('defers negotiated requests for pause, live cap and pressure, but never old callers', () => {
    const paused: AutomaticWorkMode = { kind: 'paused', reason: 'unclean_host_death', since: 0 }
    const negotiated = facts({ declaredIntent: 'automatic-restore' })
    const state = createSpawnAdmissionState(LIMITS, 0)
    expect(decide(state, negotiated, 0, 'ok', paused)).toEqual({ kind: 'defer', reason: 'paused' })
    expect(decide(state, facts(), 0, 'ok', paused).kind).toBe('admit')
    expect(decide(state, negotiated, 0, 'critical')).toEqual({ kind: 'defer', reason: 'pressure' })
    expect(decide(state, facts({ deadlineAt: 500 }), 0, 'critical')).toEqual({
      kind: 'wait',
      charge: 'automatic',
      retryAt: null
    })
    expect(decide(state, facts({ deadlineAt: 500 }), 500, 'critical')).toEqual({
      kind: 'refuse_retryable'
    })

    state.liveAutomatic = LIMITS.maxLiveAutomatic
    expect(decide(state, negotiated, 0)).toEqual({ kind: 'defer', reason: 'live_cap' })
    expect(decide(state, facts(), 0).kind).toBe('admit')
  })

  it('admits an old caller whose retry would miss its deadline and defers a negotiated one', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    state.automaticBucket = { tokens: 0, updatedAt: 0 }
    expect(decide(state, facts({ deadlineAt: 500 }), 0)).toEqual({
      kind: 'admit',
      charge: 'automatic'
    })
    expect(decide(state, facts({ deadlineAt: 500, declaredIntent: 'automation' }), 0)).toEqual({
      kind: 'defer',
      reason: 'deadline'
    })
  })

  it('admits a user resume past its deadline instead of waiting forever for a slot', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    const f = facts({ declaredIntent: 'user-resume', deadlineAt: 500 })
    for (let i = 0; i < LIMITS.userResumeConcurrency; i++) {
      applySpawnAdmission(state, f, 'user', LIMITS, 0)
    }
    expect(decide(state, f, 0)).toEqual({ kind: 'wait', charge: 'user', retryAt: null })
    expect(decide(state, f, 500)).toEqual({ kind: 'admit', charge: 'user' })
  })

  it('paces a user resume past its allowance but never puts it back to sleep', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    const f = facts({ declaredIntent: 'user-resume', deadlineAt: 5_000 })
    state.liveAutomatic = LIMITS.maxLiveAutomatic
    state.automaticBucket = { tokens: 0, updatedAt: 0 }
    const paused = { kind: 'paused', reason: 'unclean_host_death', since: 0 } as const
    for (const mode of [{ kind: 'normal' } as const, paused]) {
      const args = { state, facts: f, charge: 'automatic' as const, pressure: 'ok' as const }
      expect(decideSpawnAdmission({ ...args, mode, limits: LIMITS, now: 0 })).toMatchObject({
        kind: 'wait'
      })
      expect(decideSpawnAdmission({ ...args, mode, limits: LIMITS, now: 5_000 })).toEqual({
        kind: 'admit',
        charge: 'automatic'
      })
    }
  })
})
