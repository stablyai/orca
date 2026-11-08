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
