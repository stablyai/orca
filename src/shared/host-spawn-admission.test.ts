import { describe, expect, it } from 'vitest'
import {
  applySpawnAdmission,
  createSpawnAdmissionState,
  decideSpawnAdmission,
  DEFAULT_SPAWN_ADMISSION_LIMITS as LIMITS,
  readTerminalSpawnDeferral,
  releaseLiveAutomatic,
  resolveSpawnCharge,
  settleSpawnAdmission,
  type AutomaticWorkMode,
  type HostPressureLevel,
  type SpawnRequestFacts
} from './host-spawn-admission'

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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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

  it('paces automatic restores to the burst, then one per second', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    const f = facts()
    for (let i = 0; i < LIMITS.automaticBurst; i++) {
      expect(decide(state, f, 0).kind).toBe('admit')
      applySpawnAdmission(state, f, 'automatic', LIMITS, 0)
      settleSpawnAdmission(state, 'automatic', true)
    }
    expect(decide(state, f, 0)).toEqual({ kind: 'wait', charge: 'automatic', retryAt: 1000 })
    expect(decide(state, f, 1000).kind).toBe('admit')
  })

  it('waits for a released slot when automatic concurrency is full', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    const f = facts()
    for (let i = 0; i < LIMITS.automaticConcurrency; i++) {
      applySpawnAdmission(state, f, 'automatic', LIMITS, 0)
    }
    expect(decide(state, f, 60_000)).toEqual({ kind: 'wait', charge: 'automatic', retryAt: null })
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

  it('admits an old caller at its deadline instead of refusing, and defers a negotiated one', () => {
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

  it('M-1: random arrivals keep the pacing and live-cap invariants', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = mulberry32(seed)
      const state = createSpawnAdmissionState(LIMITS, 0)
      const live: { charge: 'automatic' | 'user' | 'interactive'; endsAt: number }[] = []
      const inFlight: { charge: 'automatic' | 'user' | 'interactive'; settlesAt: number }[] = []
      let now = 0
      let automaticAdmitsInWindow: number[] = []
      for (let step = 0; step < 400; step++) {
        now += Math.floor(rng() * 400)
        for (const item of inFlight.splice(0).filter((entry) => {
          if (entry.settlesAt > now) {
            inFlight.push(entry)
            return false
          }
          return true
        })) {
          settleSpawnAdmission(state, item.charge, true)
          live.push({ charge: item.charge, endsAt: now + Math.floor(rng() * 30_000) })
        }
        for (const entry of live.splice(0)) {
          if (entry.endsAt <= now) {
            if (entry.charge === 'automatic') {
              releaseLiveAutomatic(state)
            }
          } else {
            live.push(entry)
          }
        }
        const roll = rng()
        const f = facts({
          declaredIntent:
            roll < 0.2
              ? 'interactive'
              : roll < 0.3
                ? 'user-resume'
                : roll < 0.7
                  ? 'automatic-restore'
                  : null,
          clientId: rng() < 0.5 ? 'a' : 'b',
          hasAgentSessionClaim: roll >= 0.2 || rng() < 0.5
        })
        const pressure: HostPressureLevel = rng() < 0.05 ? 'critical' : 'ok'
        const decision = decide(state, f, now, pressure)
        if (f.declaredIntent === 'interactive' && !f.hasAgentSessionClaim) {
          expect(decision).toEqual({ kind: 'admit', charge: 'interactive' })
        }
        if (f.declaredIntent === null && pressure !== 'critical') {
          expect(['admit', 'wait']).toContain(decision.kind)
        }
        if (decision.kind !== 'admit') {
          continue
        }
        applySpawnAdmission(state, f, decision.charge, LIMITS, now)
        inFlight.push({ charge: decision.charge, settlesAt: now + Math.floor(rng() * 2000) })
        if (decision.charge === 'automatic') {
          automaticAdmitsInWindow = [
            ...automaticAdmitsInWindow.filter((t) => t > now - 10_000),
            now
          ]
          expect(state.inFlight.automatic).toBeLessThanOrEqual(LIMITS.automaticConcurrency)
          // Burst plus one token per second over a 10 s window.
          expect(automaticAdmitsInWindow.length).toBeLessThanOrEqual(LIMITS.automaticBurst + 10)
          // A user resume past its allowance is paced like an old caller, never capped.
          if (f.declaredIntent !== null && f.declaredIntent !== 'user-resume') {
            expect(state.liveAutomatic + state.inFlight.automatic).toBeLessThanOrEqual(
              LIMITS.maxLiveAutomatic
            )
          }
        }
      }
    }
  })
})

describe('readTerminalSpawnDeferral', () => {
  it('reads the reason from an RPC message and from the local IPC wrapper', () => {
    expect(readTerminalSpawnDeferral(new Error('terminal_spawn_deferred:paused'))).toBe('paused')
    expect(
      readTerminalSpawnDeferral(
        new Error(
          "Error invoking remote method 'pty:spawn': Error: terminal_spawn_deferred:deadline"
        )
      )
    ).toBe('deadline')
  })

  it('ignores other errors and unknown reasons', () => {
    expect(readTerminalSpawnDeferral(new Error('ENOENT'))).toBeNull()
    expect(readTerminalSpawnDeferral(new Error('terminal_spawn_deferred:later'))).toBeNull()
    expect(readTerminalSpawnDeferral(undefined)).toBeNull()
  })
})
