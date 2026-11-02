// One automatic-restore budget per execution host: every daemon the user runs on a machine
// adds the automatic work the others publish before it decides (owner decision Q1).
import type { SpawnAdmissionLimits, SpawnAdmissionState } from './host-spawn-admission'

/** Automatic work another daemon on this host published. */
export type OtherAutomaticWork = {
  inFlight: number
  live: number
  /** When it admitted automatic forks, within the history window. */
  admits: readonly number[]
}

export const NO_OTHER_AUTOMATIC_WORK: OtherAutomaticWork = { inFlight: 0, live: 0, admits: [] }

// Why 10 s: past three times the bucket's full refill, an older admit barely moves the result.
export const AUTOMATIC_ADMIT_HISTORY_MS = 10_000

export function recentAutomaticAdmits(admits: readonly number[], now: number): number[] {
  return admits.filter((at) => at <= now && now - at <= AUTOMATIC_ADMIT_HISTORY_MS)
}

/** Replays every daemon's recent admits through one bucket that was full at the window start. */
function hostBucketTokens(
  admits: readonly number[],
  limits: SpawnAdmissionLimits,
  now: number
): number {
  const perMs = limits.automaticTokensPerSecond / 1000
  let tokens = limits.automaticBurst
  let at = now - AUTOMATIC_ADMIT_HISTORY_MS
  for (const admit of [...recentAutomaticAdmits(admits, now)].sort((a, b) => a - b)) {
    tokens = Math.max(0, Math.min(limits.automaticBurst, tokens + (admit - at) * perMs) - 1)
    at = admit
  }
  return Math.min(limits.automaticBurst, tokens + (now - at) * perMs)
}

/**
 * This daemon's admission state as the policy should see it: its own in-flight and live
 * automatic work plus everyone else's, and a rate bucket no fuller than either view.
 * The result is for one decision only; accounting stays on the daemon's own state.
 */
export function withOtherDaemonsAutomaticWork(
  state: SpawnAdmissionState,
  others: OtherAutomaticWork,
  ownAdmits: readonly number[],
  limits: SpawnAdmissionLimits,
  now: number
): SpawnAdmissionState {
  if (others.inFlight === 0 && others.live === 0 && others.admits.length === 0) {
    return state
  }
  const ownElapsed = Math.max(0, now - state.automaticBucket.updatedAt)
  const ownTokens = Math.min(
    limits.automaticBurst,
    state.automaticBucket.tokens + (ownElapsed * limits.automaticTokensPerSecond) / 1000
  )
  return {
    ...state,
    inFlight: { ...state.inFlight, automatic: state.inFlight.automatic + others.inFlight },
    liveAutomatic: state.liveAutomatic + others.live,
    automaticBucket: {
      tokens: Math.min(ownTokens, hostBucketTokens([...ownAdmits, ...others.admits], limits, now)),
      updatedAt: now
    }
  }
}
