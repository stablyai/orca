/**
 * Durable agent-session record and its single-writer lease.
 *
 * The record is the session's identity — where it runs, which provider it talks to, which account
 * home is pinned to it — and is independent of any terminal tab. The lease is the separate
 * question of which process is currently allowed to write to it.
 */

import type { ExecutionHostId } from './execution-host'
import {
  isAgentSessionProviderHandleChain,
  type AgentSessionHandleProvider,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'

export const AGENT_SESSION_RECORD_SCHEMA_VERSION = 2 as const

export type AgentSessionWorkspaceKind = 'git-worktree' | 'folder'

/**
 * Where the provider process actually runs. WSL is called out separately from the execution host
 * id because a WSL workspace is served by the local host but is a distinct filesystem, account
 * root, and process namespace — two sessions there must never collide with their native twins.
 */
export type AgentSessionExecutionLocation = {
  executionHostId: ExecutionHostId
  /** Distro name when the provider runs inside WSL; null for native and remote hosts. */
  wslDistro: string | null
  workspaceId: string
  workspaceKind: AgentSessionWorkspaceKind
}

/** Account root pinned at launch by the account selector, so a resume cannot drift to another login. */
export type AgentSessionAccountHome = {
  variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  /** Host-resolved absolute path in the execution host's own path syntax. */
  path: string
}

/** Provider launch environment captured by the host when the session is created. */
export type AgentSessionLaunchEnv = Record<string, string>

/** Provider CLI arguments captured by the host when the session is created. */
export type AgentSessionLaunchArgs = string[]

export type AgentSessionOwnerRuntimeKind = 'native' | 'tui'

export type AgentSessionHandoffStage =
  | 'preparing'
  | 'old-owner-stopped'
  | 'new-owner-proving'
  | 'recovering'
  | 'manual-recovery'

/**
 * PID-reuse-safe process identity. `spawnToken` is the only element available on every platform:
 * process start time costs a CIM query on Windows and is absent in some containers. An exact
 * identity stays in `recovering`; an ownerless, unattributable reservation uses `manual-recovery`.
 */
export type AgentSessionProcessIdentity = {
  hostId: string
  pid: number
  processStartTimeMs: number | null
  spawnToken: string
}

export type AgentSessionJournalCheckpoint = { epoch: number; sequence: number }

/**
 * Mirrors the in-memory claim registry's reserved / live / conflicted states so a conflict
 * survives a restart. `released` has no registry equivalent: the registry expresses "no owner" by
 * deleting the entry, and a durable record that outlives its owner needs a name for that.
 */
export type AgentSessionClaimStatus = 'reserved' | 'live' | 'conflicted' | 'released'

export type AgentSessionDeathEvidence = {
  kind: 'exit-observed' | 'pid-absent' | 'identity-mismatch'
  detail: string
  observedAt: number
}

export type AgentSessionLease = {
  sessionId: string
  runtimeKind: AgentSessionOwnerRuntimeKind
  /** Durable monotonic integer; only acquisition CAS and proven eviction move it. */
  runtimeFence: number
  handoffStage: AgentSessionHandoffStage | null
  /** Link id of the provider handle this owner proved; the full chain lives on the record. */
  provenHandleLinkId: string | null
  /** Null between the durable reservation and the observed spawn. */
  ownerProcess: AgentSessionProcessIdentity | null
  /** Reserved before any process exists, then matched against the child's environment. */
  reservedSpawnToken: string | null
  /** Set only when acquisition failed before any spawn attempt. */
  processlessAt?: number | null
  leaseDeadlineAt: number
  lastRenewedAt: number
  handoffOperationId: string | null
  journalCheckpoint: AgentSessionJournalCheckpoint | null
  /** Key id that minted the HMAC claim this lease was granted under. */
  claimKeyId: string
  claimStatus: AgentSessionClaimStatus
  /** True from load until the host adjudicates it; no writer is granted while set. */
  unreconciled: boolean
  /**
   * Lowest fence a future grant may use. Set only after the store recovers from its backup, where
   * the commit that never landed may already have granted a fence the backup cannot show. The
   * CURRENT fence is deliberately left alone: `live` means a handle proven at exactly that number,
   * so rewriting it would invalidate the record it is trying to save.
   */
  minimumNextFence?: number
  deathEvidence: AgentSessionDeathEvidence | null
  /** A positively observed provider exit whose terminal journal settlement still needs retry. */
  settlementRetryRequired?: boolean
  /** Stable lifecycle batch id used when retrying the terminal settlement. */
  settlementRetryId?: string
}

export type AgentSessionRecord = {
  schemaVersion: typeof AGENT_SESSION_RECORD_SCHEMA_VERSION
  sessionId: string
  location: AgentSessionExecutionLocation
  provider: AgentSessionHandleProvider
  providerHandleChain: AgentSessionProviderHandleLink[]
  accountHome: AgentSessionAccountHome
  /** Provider options acknowledged for the next turn, restored across owner replacement. */
  options?: Record<string, string>
  launchArgs?: AgentSessionLaunchArgs
  lease: AgentSessionLease
  createdAt: number
  updatedAt: number
}

export type AgentSessionOptionsReplacement = {
  sessionId: string
  fence: number
  options: Readonly<Record<string, string>>
  now: number
}

const MAX_ID_LENGTH = 512
const MAX_PATH_LENGTH = 4096
const MAX_LAUNCH_ENV_ENTRIES = 256
const MAX_LAUNCH_ENV_VALUE_LENGTH = 65_536
const MAX_LAUNCH_ARGS = 256
const MAX_LAUNCH_ARGS_BYTES = 16 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isAgentSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** NUL cannot occur in a host id, distro name, or workspace id, so no component can forge a join. */
const SCOPE_KEY_SEPARATOR = '\u0000'

/**
 * Scope key for host-and-workspace isolation. Native, WSL, and SSH copies of one workspace id are
 * different sessions; collapsing them would let one host adjudicate another host's lease.
 */
export function agentSessionScopeKey(location: AgentSessionExecutionLocation): string {
  return [location.executionHostId, location.wslDistro ?? '', location.workspaceId].join(
    SCOPE_KEY_SEPARATOR
  )
}

export function agentSessionExecutionLocationsEqual(
  left: AgentSessionExecutionLocation,
  right: AgentSessionExecutionLocation
): boolean {
  return (
    agentSessionScopeKey(left) === agentSessionScopeKey(right) &&
    left.workspaceKind === right.workspaceKind
  )
}

export function isAgentSessionExecutionLocation(
  value: unknown
): value is AgentSessionExecutionLocation {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const location = value as Partial<AgentSessionExecutionLocation>
  return (
    isBoundedString(location.executionHostId, MAX_ID_LENGTH) &&
    (location.wslDistro === null || isBoundedString(location.wslDistro, MAX_ID_LENGTH)) &&
    isBoundedString(location.workspaceId, MAX_ID_LENGTH) &&
    (location.workspaceKind === 'git-worktree' || location.workspaceKind === 'folder')
  )
}

export function isAgentSessionProcessIdentity(
  value: unknown
): value is AgentSessionProcessIdentity {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const identity = value as Partial<AgentSessionProcessIdentity>
  return (
    isBoundedString(identity.hostId, MAX_ID_LENGTH) &&
    Number.isSafeInteger(identity.pid) &&
    (identity.pid as number) > 0 &&
    (identity.processStartTimeMs === null ||
      (Number.isSafeInteger(identity.processStartTimeMs) &&
        (identity.processStartTimeMs as number) >= 0)) &&
    isBoundedString(identity.spawnToken, MAX_ID_LENGTH)
  )
}

function isAgentSessionAccountHome(value: unknown): value is AgentSessionAccountHome {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const home = value as Partial<AgentSessionAccountHome>
  return (
    (home.variable === 'CLAUDE_CONFIG_DIR' || home.variable === 'CODEX_HOME') &&
    isBoundedString(home.path, MAX_PATH_LENGTH)
  )
}

function isAgentSessionOptions(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= 32 &&
    entries.every(
      ([key, option]) =>
        isBoundedString(key, MAX_ID_LENGTH) && isBoundedString(option, MAX_ID_LENGTH)
    )
  )
}

export function isAgentSessionLaunchEnv(value: unknown): value is AgentSessionLaunchEnv {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_LAUNCH_ENV_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        isBoundedString(key, MAX_ID_LENGTH) &&
        typeof entry === 'string' &&
        entry.length <= MAX_LAUNCH_ENV_VALUE_LENGTH
    )
  )
}

function isAgentSessionJournalCheckpoint(value: unknown): value is AgentSessionJournalCheckpoint {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const checkpoint = value as Partial<AgentSessionJournalCheckpoint>
  return (
    Number.isSafeInteger(checkpoint.epoch) &&
    (checkpoint.epoch as number) >= 0 &&
    Number.isSafeInteger(checkpoint.sequence) &&
    (checkpoint.sequence as number) >= 0
  )
}

function isAgentSessionDeathEvidence(value: unknown): value is AgentSessionDeathEvidence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const evidence = value as Partial<AgentSessionDeathEvidence>
  return (
    (evidence.kind === 'exit-observed' ||
      evidence.kind === 'pid-absent' ||
      evidence.kind === 'identity-mismatch') &&
    isBoundedString(evidence.detail, MAX_ID_LENGTH) &&
    Number.isSafeInteger(evidence.observedAt) &&
    (evidence.observedAt as number) >= 0
  )
}

function isAgentSessionLease(value: unknown): value is AgentSessionLease {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const lease = value as Partial<AgentSessionLease>
  return (
    isAgentSessionId(lease.sessionId) &&
    (lease.runtimeKind === 'native' || lease.runtimeKind === 'tui') &&
    Number.isSafeInteger(lease.runtimeFence) &&
    (lease.runtimeFence as number) >= 0 &&
    (lease.handoffStage === null ||
      lease.handoffStage === 'preparing' ||
      lease.handoffStage === 'old-owner-stopped' ||
      lease.handoffStage === 'new-owner-proving' ||
      lease.handoffStage === 'recovering' ||
      lease.handoffStage === 'manual-recovery') &&
    (lease.provenHandleLinkId === null || isBoundedString(lease.provenHandleLinkId, 128)) &&
    (lease.ownerProcess === null || isAgentSessionProcessIdentity(lease.ownerProcess)) &&
    (lease.reservedSpawnToken === null ||
      isBoundedString(lease.reservedSpawnToken, MAX_ID_LENGTH)) &&
    (lease.processlessAt === undefined ||
      lease.processlessAt === null ||
      (Number.isSafeInteger(lease.processlessAt) && (lease.processlessAt as number) >= 0)) &&
    Number.isSafeInteger(lease.leaseDeadlineAt) &&
    Number.isSafeInteger(lease.lastRenewedAt) &&
    (lease.handoffOperationId === null ||
      isBoundedString(lease.handoffOperationId, MAX_ID_LENGTH)) &&
    (lease.journalCheckpoint === null ||
      isAgentSessionJournalCheckpoint(lease.journalCheckpoint)) &&
    isBoundedString(lease.claimKeyId, MAX_ID_LENGTH) &&
    (lease.claimStatus === 'reserved' ||
      lease.claimStatus === 'live' ||
      lease.claimStatus === 'conflicted' ||
      lease.claimStatus === 'released') &&
    typeof lease.unreconciled === 'boolean' &&
    (lease.settlementRetryRequired === undefined ||
      typeof lease.settlementRetryRequired === 'boolean') &&
    (lease.settlementRetryId === undefined ||
      isBoundedString(lease.settlementRetryId, MAX_ID_LENGTH)) &&
    (lease.deathEvidence === null || isAgentSessionDeathEvidence(lease.deathEvidence))
  )
}

export function isAgentSessionRecord(value: unknown): value is AgentSessionRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Partial<AgentSessionRecord>
  const shapeValid =
    record.schemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION &&
    isAgentSessionId(record.sessionId) &&
    isAgentSessionExecutionLocation(record.location) &&
    (record.provider === 'claude' || record.provider === 'codex') &&
    isAgentSessionProviderHandleChain(record.providerHandleChain) &&
    isAgentSessionAccountHome(record.accountHome) &&
    (record.options === undefined || isAgentSessionOptions(record.options)) &&
    (record.launchArgs === undefined || isAgentSessionLaunchArgs(record.launchArgs)) &&
    !Object.hasOwn(record, 'launchEnv') &&
    isAgentSessionLease(record.lease) &&
    record.lease.sessionId === record.sessionId &&
    Number.isSafeInteger(record.createdAt) &&
    Number.isSafeInteger(record.updatedAt)
  if (!shapeValid) {
    return false
  }
  const validated = record as AgentSessionRecord
  const head = validated.providerHandleChain.at(-1)
  return (
    validated.providerHandleChain.every((link) => link.handle.provider === validated.provider) &&
    (validated.lease.claimStatus !== 'live' ||
      (validated.lease.ownerProcess !== null &&
        head?.linkId === validated.lease.provenHandleLinkId &&
        head.mintedAtFence === validated.lease.runtimeFence))
  )
}

export function isAgentSessionLaunchArgs(value: unknown): value is AgentSessionLaunchArgs {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LAUNCH_ARGS &&
    value.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_LAUNCH_ARGS_BYTES
  )
}
