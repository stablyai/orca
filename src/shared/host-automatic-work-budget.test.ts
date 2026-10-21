import { describe, expect, it } from 'vitest'
import {
  createSpawnAdmissionState,
  decideSpawnAdmission,
  DEFAULT_SPAWN_ADMISSION_LIMITS as LIMITS,
  type SpawnRequestFacts
} from './host-spawn-admission'
import {
  AUTOMATIC_ADMIT_HISTORY_MS,
  NO_OTHER_AUTOMATIC_WORK,
  withOtherDaemonsAutomaticWork
} from './host-automatic-work-budget'

const declared: SpawnRequestFacts = {
  clientId: 'client-a',
  declaredIntent: 'automatic-restore',
  hasAgentSessionClaim: true,
  hasHistorySeed: true,
  deadlineAt: Number.POSITIVE_INFINITY
}

function decide(state: ReturnType<typeof createSpawnAdmissionState>, now: number) {
  return decideSpawnAdmission({
    state,
    facts: declared,
    charge: 'automatic',
    pressure: 'ok',
    mode: { kind: 'normal' },
    limits: LIMITS,
    now
  })
}

describe('withOtherDaemonsAutomaticWork', () => {
  it('returns the daemon state unchanged when no other daemon has automatic work', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    expect(withOtherDaemonsAutomaticWork(state, NO_OTHER_AUTOMATIC_WORK, [], LIMITS, 0)).toBe(state)
  })

  it('counts another daemon live restores against the one live cap', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    state.liveAutomatic = 3
    const host = withOtherDaemonsAutomaticWork(
      state,
      { inFlight: 0, live: 5, admits: [] },
      [],
      LIMITS,
      60_000
    )
    expect(decide(host, 60_000)).toEqual({ kind: 'defer', reason: 'live_cap' })
    expect(decide(state, 60_000)).toEqual({ kind: 'admit', charge: 'automatic' })
  })

  it('shares one concurrency limit', () => {
    const state = createSpawnAdmissionState(LIMITS, 0)
    const host = withOtherDaemonsAutomaticWork(
      state,
      { inFlight: 3, live: 0, admits: [] },
      [],
      LIMITS,
      60_000
    )
    expect(decide(host, 60_000)).toMatchObject({ kind: 'wait', retryAt: null })
  })

  it('spends one rate budget across daemons', () => {
    const now = 100_000
    const state = createSpawnAdmissionState(LIMITS, now)
    const host = withOtherDaemonsAutomaticWork(
      state,
      { inFlight: 0, live: 0, admits: [now - 20, now - 10] },
      [now - 5],
      LIMITS,
      now
    )
    expect(decide(host, now)).toMatchObject({ kind: 'wait' })
    expect(decide(host, now + 1000)).toEqual({ kind: 'admit', charge: 'automatic' })
  })

  it('forgets admits older than the history window', () => {
    const now = 100_000
    const state = createSpawnAdmissionState(LIMITS, now)
    const old = now - AUTOMATIC_ADMIT_HISTORY_MS - 1
    const host = withOtherDaemonsAutomaticWork(
      state,
      { inFlight: 0, live: 0, admits: [old, old, old] },
      [],
      LIMITS,
      now
    )
    expect(decide(host, now)).toEqual({ kind: 'admit', charge: 'automatic' })
  })

  it('never makes this daemon more permissive than its own bucket', () => {
    const now = 100_000
    const state = createSpawnAdmissionState(LIMITS, now)
    state.automaticBucket = { tokens: 0, updatedAt: now }
    const host = withOtherDaemonsAutomaticWork(
      state,
      { inFlight: 0, live: 1, admits: [] },
      [],
      LIMITS,
      now
    )
    expect(decide(host, now)).toMatchObject({ kind: 'wait' })
  })
})
