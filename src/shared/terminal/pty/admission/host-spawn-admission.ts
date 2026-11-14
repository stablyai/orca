import type {
  SpawnCharge,
  SpawnAdmissionLimits,
  SpawnRequestFacts,
  HostPressureLevel,
  AutomaticWorkMode,
  SpawnAdmissionDecision
} from './spawn-admission-contract'

type TokenBucket = { tokens: number; updatedAt: number }

export type SpawnAdmissionState = {
  inFlight: Record<SpawnCharge, number>
  liveAutomatic: number
  automaticBucket: TokenBucket
  userResumeBuckets: Map<string, TokenBucket>
}

export function createSpawnAdmissionState(
  limits: SpawnAdmissionLimits,
  now: number
): SpawnAdmissionState {
  return {
    inFlight: { interactive: 0, user: 0, automatic: 0 },
    liveAutomatic: 0,
    automaticBucket: { tokens: limits.automaticBurst, updatedAt: now },
    userResumeBuckets: new Map()
  }
}

function refill(
  bucket: TokenBucket,
  capacity: number,
  tokensPerMs: number,
  now: number
): TokenBucket {
  const elapsed = Math.max(0, now - bucket.updatedAt)
  return { tokens: Math.min(capacity, bucket.tokens + elapsed * tokensPerMs), updatedAt: now }
}

function automaticTokensPerMs(limits: SpawnAdmissionLimits): number {
  return limits.automaticTokensPerSecond / 1000
}

function userResumeTokensPerMs(limits: SpawnAdmissionLimits): number {
  return limits.userResumeBucketCapacity / limits.userResumeBucketWindowMs
}

/** Old callers get inference from facts the host holds; a declared `user-resume`
 *  above its per-client bucket is charged as automatic so it cannot bypass pacing. */
export function resolveSpawnCharge(
  state: SpawnAdmissionState,
  facts: SpawnRequestFacts,
  limits: SpawnAdmissionLimits,
  now: number
): SpawnCharge {
  // Remote resumes have fresh terminal ids/no history seed, so infer from claims alone to pace reconnect storms.
  // Legacy callers incur at most a short wait for user-started work.
  const inferred = facts.hasAgentSessionClaim ? 'automatic-restore' : 'interactive'
  // A claimed resume cannot use interactive to bypass admission.
  const intent =
    facts.declaredIntent === 'interactive' ? inferred : (facts.declaredIntent ?? inferred)
  if (intent === 'interactive') {
    return 'interactive'
  }
  if (intent === 'user-resume') {
    const bucket = refill(
      state.userResumeBuckets.get(facts.clientId) ?? {
        tokens: limits.userResumeBucketCapacity,
        updatedAt: now
      },
      limits.userResumeBucketCapacity,
      userResumeTokensPerMs(limits),
      now
    )
    return bucket.tokens >= 1 ? 'user' : 'automatic'
  }
  return 'automatic'
}

export function decideSpawnAdmission(args: {
  state: SpawnAdmissionState
  facts: SpawnRequestFacts
  charge: SpawnCharge
  pressure: HostPressureLevel
  mode: AutomaticWorkMode
  limits: SpawnAdmissionLimits
  now: number
}): SpawnAdmissionDecision {
  const { state, facts, charge, pressure, mode, limits, now } = args
  if (charge === 'interactive') {
    return { kind: 'admit', charge }
  }
  if (charge === 'user') {
    // Why: a user action is never refused; past its deadline it goes ahead regardless.
    return state.inFlight.user < limits.userResumeConcurrency || now >= facts.deadlineAt
      ? { kind: 'admit', charge }
      : { kind: 'wait', charge, retryAt: null }
  }
  const negotiated = facts.declaredIntent !== null
  if (pressure === 'critical') {
    if (negotiated) {
      return { kind: 'defer', reason: 'pressure' }
    }
    // Legacy clients clear resume handles before spawning; refuse only after the entire admission window.
    return now >= facts.deadlineAt
      ? { kind: 'refuse_retryable' }
      : { kind: 'wait', charge, retryAt: null }
  }
  // Why: a user's resume past its allowance is paced, never put back to sleep in front of them.
  const mayDefer = negotiated && facts.declaredIntent !== 'user-resume'
  if (mayDefer && mode.kind === 'paused') {
    return { kind: 'defer', reason: 'paused' }
  }
  if (mayDefer && state.liveAutomatic + state.inFlight.automatic >= limits.maxLiveAutomatic) {
    return { kind: 'defer', reason: 'live_cap' }
  }
  const bucket = refill(
    state.automaticBucket,
    limits.automaticBurst,
    automaticTokensPerMs(limits),
    now
  )
  const concurrencyFull = state.inFlight.automatic >= limits.automaticConcurrency
  if (!concurrencyFull && bucket.tokens >= 1) {
    return { kind: 'admit', charge }
  }
  const retryAt = concurrencyFull
    ? null
    : now + Math.ceil((1 - bucket.tokens) / automaticTokensPerMs(limits))
  if (retryAt !== null ? retryAt > facts.deadlineAt : now >= facts.deadlineAt) {
    // Why: an old caller is admitted at its deadline rather than refused (degraded pacing).
    return mayDefer ? { kind: 'defer', reason: 'deadline' } : { kind: 'admit', charge }
  }
  return { kind: 'wait', charge, retryAt }
}

/** Apply accounting without negative buckets so observe-only admission still reports realistic would-wait counts. */
export function applySpawnAdmission(
  state: SpawnAdmissionState,
  facts: SpawnRequestFacts,
  charge: SpawnCharge,
  limits: SpawnAdmissionLimits,
  now: number
): void {
  state.inFlight[charge] += 1
  if (charge === 'automatic') {
    const bucket = refill(
      state.automaticBucket,
      limits.automaticBurst,
      automaticTokensPerMs(limits),
      now
    )
    state.automaticBucket = { tokens: Math.max(0, bucket.tokens - 1), updatedAt: now }
  } else if (charge === 'user') {
    const bucket = refill(
      state.userResumeBuckets.get(facts.clientId) ?? {
        tokens: limits.userResumeBucketCapacity,
        updatedAt: now
      },
      limits.userResumeBucketCapacity,
      userResumeTokensPerMs(limits),
      now
    )
    state.userResumeBuckets.set(facts.clientId, {
      tokens: Math.max(0, bucket.tokens - 1),
      updatedAt: now
    })
  }
}

/** Ends an admitted fork's in-flight slot; `becameLive` counts it against the live cap. */
export function settleSpawnAdmission(
  state: SpawnAdmissionState,
  charge: SpawnCharge,
  becameLive: boolean
): void {
  state.inFlight[charge] = Math.max(0, state.inFlight[charge] - 1)
  if (charge === 'automatic' && becameLive) {
    state.liveAutomatic += 1
  }
}

export function releaseLiveAutomatic(state: SpawnAdmissionState): void {
  state.liveAutomatic = Math.max(0, state.liveAutomatic - 1)
}

/** Drops idle full buckets so a long-lived host does not keep one per past client. */
export function pruneUserResumeBuckets(
  state: SpawnAdmissionState,
  limits: SpawnAdmissionLimits,
  now: number
): void {
  for (const [clientId, bucket] of state.userResumeBuckets) {
    if (
      refill(bucket, limits.userResumeBucketCapacity, userResumeTokensPerMs(limits), now).tokens >=
      limits.userResumeBucketCapacity
    ) {
      state.userResumeBuckets.delete(clientId)
    }
  }
}
