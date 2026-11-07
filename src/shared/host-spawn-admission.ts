// Clock-injected fork admission runs only at the terminal-daemon creation owner; attach/adoption are never charged.

export type SpawnIntent = 'interactive' | 'user-resume' | 'automatic-restore' | 'automation'

export type SpawnCharge = 'interactive' | 'user' | 'automatic'

export type HostPressureLevel = 'ok' | 'elevated' | 'critical' | 'unknown'

export type AutomaticWorkMode =
  | { kind: 'normal' }
  | {
      kind: 'paused'
      reason: 'unclean_host_death' | 'pressure' | 'operator'
      since: number
    }

/** Refused legacy restore whose old client already cleared its resume handle; this record is the only remaining copy. */
export type LegacyRestoreRecord = {
  sessionId: string
  reason: 'pressure' | 'host_cap'
  refusedAt: number
  agent: string | null
  cwd: string | null
  worktreeId: string | null
  /** The resume command line the client sent; running it in `cwd` resumes the agent. */
  command: string | null
  identityDigest: string | null
}

/** What a daemon reports about automatic restores; `admission` says whether its gate enforces. */
export type AutomaticWorkStatus = {
  admission: 'observe' | 'enforce'
  mode: AutomaticWorkMode
  /** Absent from daemons that predate the record; clients treat absence as none. */
  legacyRestores?: readonly LegacyRestoreRecord[]
}

/** `cleared` is the pause the resume lifted, or null when automatic restores were running. */
export type AutomaticWorkResumeResult = AutomaticWorkStatus & { cleared: AutomaticWorkMode | null }

/** A gate-bearing terminal host from before resume existed: its pause is real but unreachable. */
export const AUTOMATIC_WORK_RESUME_UNSUPPORTED = 'terminal-host-predates-resume'

export type AutomaticWorkResumeOutcome =
  | AutomaticWorkResumeResult
  | typeof AUTOMATIC_WORK_RESUME_UNSUPPORTED
  | null

export type SpawnRequestFacts = {
  clientId: string
  /** Null when the caller predates the field; presence opts the request into `defer`. */
  declaredIntent: SpawnIntent | null
  hasAgentSessionClaim: boolean
  hasHistorySeed: boolean
  /** Latest time a paced request may still be admitted, on the gate's clock. */
  deadlineAt: number
}

export const SPAWN_INTENTS = [
  'interactive',
  'user-resume',
  'automatic-restore',
  'automation'
] as const satisfies readonly SpawnIntent[]

export function isSpawnIntent(value: unknown): value is SpawnIntent {
  return typeof value === 'string' && SPAWN_INTENTS.some((intent) => intent === value)
}

/** Never accept interactive from clients: it bypasses admission and older daemons surviving updates still trust it. */
export const RESTORE_SPAWN_INTENTS = [
  'user-resume',
  'automatic-restore'
] as const satisfies readonly SpawnIntent[]

export type RestoreSpawnIntent = (typeof RESTORE_SPAWN_INTENTS)[number]

export function isRestoreSpawnIntent(value: unknown): value is RestoreSpawnIntent {
  return typeof value === 'string' && RESTORE_SPAWN_INTENTS.some((intent) => intent === value)
}

export type SpawnDeferralReason = 'paused' | 'live_cap' | 'pressure' | 'deadline'

/** Sent only to requests that declared an intent; the fork never started. */
export const TERMINAL_SPAWN_DEFERRED_CODE = 'terminal_spawn_deferred'
export const TERMINAL_SPAWN_DEFERRED_PREFIX = `${TERMINAL_SPAWN_DEFERRED_CODE}:`
/** Critical-pressure refusal for undeclared callers; avoid daemon-gone wording that would replace a healthy daemon. */
export const TERMINAL_SPAWN_REFUSED_MESSAGE = 'terminal_spawn_refused: host under pressure'

export function parseTerminalSpawnDeferral(message: string): SpawnDeferralReason | null {
  if (!message.startsWith(TERMINAL_SPAWN_DEFERRED_PREFIX)) {
    return null
  }
  const reason = message.slice(TERMINAL_SPAWN_DEFERRED_PREFIX.length)
  return reason === 'paused' ||
    reason === 'live_cap' ||
    reason === 'pressure' ||
    reason === 'deadline'
    ? reason
    : null
}

/** Finds a deferral in a spawn error, whether an RPC failure or the local IPC's wrapped message. */
export function readTerminalSpawnDeferral(error: unknown): SpawnDeferralReason | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const index = message.indexOf(TERMINAL_SPAWN_DEFERRED_PREFIX)
  return index === -1 ? null : parseTerminalSpawnDeferral(message.slice(index).split(/\s/)[0])
}

export type SpawnAdmissionDecision =
  | { kind: 'admit'; charge: SpawnCharge }
  /** `retryAt` null means "until a slot is released". */
  | { kind: 'wait'; charge: SpawnCharge; retryAt: number | null }
  | { kind: 'defer'; reason: SpawnDeferralReason }
  | { kind: 'refuse_retryable' }

export type SpawnAdmissionLimits = {
  automaticConcurrency: number
  automaticTokensPerSecond: number
  automaticBurst: number
  maxLiveAutomatic: number
  userResumeConcurrency: number
  userResumeBucketCapacity: number
  userResumeBucketWindowMs: number
}

// Initial defaults; tune from the observe-only counts.
export const DEFAULT_SPAWN_ADMISSION_LIMITS: SpawnAdmissionLimits = {
  automaticConcurrency: 3,
  automaticTokensPerSecond: 1,
  automaticBurst: 3,
  maxLiveAutomatic: 8,
  userResumeConcurrency: 3,
  userResumeBucketCapacity: 4,
  userResumeBucketWindowMs: 10_000
}

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
