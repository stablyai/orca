import { isAgentSessionRewindRecord, type AgentSessionRewindRecord } from './agent-session-rewind'
import { isAgentSessionLaunchArgs } from './agent-session-launch-args'
import { isAgentSessionConversationName } from './agent-session/agent-session-conversation-name'
import {
  isPersistedAgentSessionHandoffStage,
  isPersistedAgentSessionRuntimeKind,
  type PersistedAgentSessionLease,
  type PersistedAgentSessionRecord
} from './agent-session-legacy-handoff-lease'
/** Identity pins location, provider and account home independently of terminal tabs; the lease separately grants one process writer authority. */

import type { ExecutionHostId } from './execution-host'
import {
  isAgentSessionConversationCommandRecord,
  type AgentSessionConversationCommandRecord
} from './agent-session/agent-session-conversation-command'
import {
  decodePersistedAgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import {
  isAgentSessionProviderContextBoundary,
  type AgentSessionProviderContextBoundary
} from './agent-session-provider-context'
import { isStructuredAgentId } from './agent-session-provider-handle-encoding'
import {
  isAgentSessionAccountHome,
  MAX_PATH_LENGTH,
  type AgentSessionAccountHome
} from './agent-session-account-home'

export type { AgentSessionAccountHome } from './agent-session-account-home'

export const AGENT_SESSION_RECORD_SCHEMA_VERSION = 2 as const

export type AgentSessionWorkspaceKind = 'git-worktree' | 'folder'

/** WSL shares the local host id but has a distinct filesystem, account root and process namespace; isolate sessions from native twins. */
export type AgentSessionExecutionLocation = {
  executionHostId: ExecutionHostId
  /** Distro name when the provider runs inside WSL; null for native and remote hosts. */
  wslDistro: string | null
  workspaceId: string
  workspaceKind: AgentSessionWorkspaceKind
}

/** Provider launch environment captured by the host when the session is created. */
export type AgentSessionLaunchEnv = Record<string, string>

/** Provider CLI arguments captured by the host when the session is created. */
export type AgentSessionLaunchArgs = string[]

/** Still persisted because older builds read it. The removed terminal handoff's `tui` is mapped
 *  away at decode (agent-session-legacy-handoff-lease). */
export type AgentSessionOwnerRuntimeKind = 'native'

/** The acquisition stage. Stages only older builds wrote are mapped away at decode. */
export type AgentSessionHandoffStage = 'new-owner-proving' | 'recovering'

/** Use spawnToken across platforms; start time requires Windows CIM and is unavailable in some containers. */
export type AgentSessionProcessIdentity = {
  hostId: string
  pid: number
  processStartTimeMs: number | null
  spawnToken: string
  /** The Orca runtime that started this process and holds its transport, stamped when the owner is
   *  recorded; absent on owners older builds recorded. */
  runtime?: string
}

/** released has no owner; conflicted retains a legacy terminal owner that recovery waits for and never stops because it is the user's agent. */
export type AgentSessionClaimStatus = 'reserved' | 'live' | 'conflicted' | 'released'

export type AgentSessionDeathEvidence = {
  kind: 'exit-observed' | 'pid-absent' | 'identity-mismatch'
  detail: string
  observedAt: number
  /** Fence of the owner (or reservation) this death is about; a fence names exactly one. Absent on
   *  evidence older builds wrote, which then speaks for no turn. */
  ownerFence?: number
  /** Last liveness proof by the transport holder; absent for surface release, failed start or older evidence. */
  lastProvenAliveAt?: number
  /** Quit/update/crash when the provider died with its runtime; absent for independent/unknown death. Keep open strings and read with isAgentSessionOrcaStopCause. */
  runtimeEnd?: string
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
  leaseDeadlineAt: number
  /** While `ownerProcess` is set, the last time its transport holder proved it alive; parking in
   *  `recovering` proves nothing, so it leaves this alone. */
  lastRenewedAt: number
  handoffOperationId: string | null
  /** Key id that minted the HMAC claim this lease was granted under. */
  claimKeyId: string
  claimStatus: AgentSessionClaimStatus
  /** True from load until the host adjudicates it; no writer is granted while set. */
  unreconciled: boolean
  /** Imported backup/set-aside copies may hide a granted fence: floor future grants, preserving the current fence required by proven live handles. */
  minimumNextFence?: number
  /** Null on a released lease when nothing proved its owner gone. */
  deathEvidence: AgentSessionDeathEvidence | null
}

export type AgentSessionRecord = {
  schemaVersion: typeof AGENT_SESSION_RECORD_SCHEMA_VERSION
  sessionId: string
  location: AgentSessionExecutionLocation
  /** The agent this session names, whether this build can run it or not. */
  provider: string
  providerHandleChain: AgentSessionProviderHandleLink[]
  providerContextBoundary?: AgentSessionProviderContextBoundary
  accountHome: AgentSessionAccountHome
  /** Initial launch directory in host path syntax. Floating sessions resume here; worktree/folder IDs resolve their durable location. */
  launchDirectory?: string
  /** Provider options the user chose, replayed whenever a new owner starts the session. */
  options?: Record<string, string>
  /** The permission mode the user chose; Orca's, so a provider's options answer never replaces it. */
  permissionMode?: string
  rewind?: AgentSessionRewindRecord
  conversationCommand?: AgentSessionConversationCommandRecord
  /** The name Orca gave this conversation, so a later acquisition need not name it again. */
  conversationName?: string
  /** When the user's Sleep stopped this chat; the next admitted send clears it. */
  sleptAt?: number
  launchArgs?: AgentSessionLaunchArgs
  lease: AgentSessionLease
  createdAt: number
  updatedAt: number
}

/** Replaces the provider options or sets the permission mode, never both, so neither write
 *  touches the other. */
export type AgentSessionOptionsReplacement = {
  sessionId: string
  fence: number
  now: number
} & ({ options: Readonly<Record<string, string>> } | { permissionMode: string })

const MAX_ID_LENGTH = 512
/** A death evidence's `detail` past this fails a load, so whoever writes one cuts it here. */
export const MAX_AGENT_SESSION_DEATH_DETAIL_CHARS = MAX_ID_LENGTH
const MAX_LAUNCH_ENV_ENTRIES = 256
const MAX_LAUNCH_ENV_VALUE_LENGTH = 65_536
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isAgentSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** NUL cannot occur in a host id, distro name, or workspace id, so no component can forge a join. */
const SCOPE_KEY_SEPARATOR = '\u0000'

/** Separate native/WSL/SSH workspace copies so one host cannot adjudicate another's lease. */
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
    isBoundedString(identity.spawnToken, MAX_ID_LENGTH) &&
    (identity.runtime === undefined || isBoundedString(identity.runtime, MAX_ID_LENGTH))
  )
}

export function isAgentSessionOptions(value: unknown): value is Record<string, string> {
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

function isAgentSessionDeathEvidence(value: unknown): value is AgentSessionDeathEvidence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const evidence = value as Partial<AgentSessionDeathEvidence>
  const { observedAt, lastProvenAliveAt, ownerFence, runtimeEnd } = evidence
  return (
    (evidence.kind === 'exit-observed' ||
      evidence.kind === 'pid-absent' ||
      evidence.kind === 'identity-mismatch') &&
    isBoundedString(evidence.detail, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS) &&
    typeof observedAt === 'number' &&
    Number.isSafeInteger(observedAt) &&
    observedAt >= 0 &&
    (ownerFence === undefined || (Number.isSafeInteger(ownerFence) && ownerFence >= 0)) &&
    (lastProvenAliveAt === undefined ||
      (Number.isSafeInteger(lastProvenAliveAt) &&
        lastProvenAliveAt >= 0 &&
        lastProvenAliveAt <= observedAt)) &&
    (runtimeEnd === undefined || isBoundedString(runtimeEnd, MAX_ID_LENGTH))
  )
}

function isPersistedAgentSessionLease(value: unknown): value is PersistedAgentSessionLease {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const lease = value as Partial<AgentSessionLease>
  return (
    isAgentSessionId(lease.sessionId) &&
    isPersistedAgentSessionRuntimeKind(lease.runtimeKind) &&
    Number.isSafeInteger(lease.runtimeFence) &&
    (lease.runtimeFence as number) >= 0 &&
    (lease.handoffStage === null || isPersistedAgentSessionHandoffStage(lease.handoffStage)) &&
    (lease.provenHandleLinkId === null || isBoundedString(lease.provenHandleLinkId, 128)) &&
    (lease.ownerProcess === null || isAgentSessionProcessIdentity(lease.ownerProcess)) &&
    (lease.reservedSpawnToken === null ||
      isBoundedString(lease.reservedSpawnToken, MAX_ID_LENGTH)) &&
    Number.isSafeInteger(lease.leaseDeadlineAt) &&
    Number.isSafeInteger(lease.lastRenewedAt) &&
    (lease.handoffOperationId === null ||
      isBoundedString(lease.handoffOperationId, MAX_ID_LENGTH)) &&
    isBoundedString(lease.claimKeyId, MAX_ID_LENGTH) &&
    (lease.claimStatus === 'reserved' ||
      lease.claimStatus === 'live' ||
      lease.claimStatus === 'conflicted' ||
      lease.claimStatus === 'released') &&
    typeof lease.unreconciled === 'boolean' &&
    (lease.deathEvidence === null || isAgentSessionDeathEvidence(lease.deathEvidence))
  )
}

/** Stored identity is independent of registrations; availability is checked only at start. */
export function isPersistedAgentSessionRecord(
  value: unknown
): value is PersistedAgentSessionRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Partial<AgentSessionRecord>
  const fieldsValid =
    record.schemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION &&
    isAgentSessionId(record.sessionId) &&
    isAgentSessionExecutionLocation(record.location) &&
    isStructuredAgentId(record.provider) &&
    isAgentSessionAccountHome(record.accountHome) &&
    (record.launchDirectory === undefined ||
      isBoundedString(record.launchDirectory, MAX_PATH_LENGTH)) &&
    (record.options === undefined || isAgentSessionOptions(record.options)) &&
    (record.permissionMode === undefined ||
      isBoundedString(record.permissionMode, MAX_ID_LENGTH)) &&
    (record.rewind === undefined || isAgentSessionRewindRecord(record.rewind)) &&
    (record.providerContextBoundary === undefined ||
      isAgentSessionProviderContextBoundary(record.providerContextBoundary)) &&
    (record.conversationCommand === undefined ||
      isAgentSessionConversationCommandRecord(record.conversationCommand)) &&
    (record.conversationName === undefined ||
      isAgentSessionConversationName(record.conversationName)) &&
    (record.launchArgs === undefined || isAgentSessionLaunchArgs(record.launchArgs)) &&
    !Object.hasOwn(record, 'launchEnv') &&
    isPersistedAgentSessionLease(record.lease) &&
    record.lease.sessionId === record.sessionId &&
    Number.isSafeInteger(record.createdAt) &&
    Number.isSafeInteger(record.updatedAt)
  if (!fieldsValid) {
    return false
  }
  const validated = record as AgentSessionRecord
  // The row holds stored handles; validate the chain they decode to.
  const chain = decodePersistedAgentSessionProviderHandleChain(validated.providerHandleChain)
  const head = chain?.at(-1)
  return (
    chain !== null &&
    // Chain validation already enforces one namespace.
    (!head || head.handle.agent === validated.provider) &&
    (validated.providerContextBoundary === undefined ||
      validated.providerContextBoundary.afterFence <= validated.lease.runtimeFence) &&
    (validated.lease.claimStatus !== 'live' ||
      (validated.lease.ownerProcess !== null &&
        // Null: the owner's process is live and its provider has not answered with a handle yet.
        (validated.lease.provenHandleLinkId === null ||
          (head?.linkId === validated.lease.provenHandleLinkId &&
            head.mintedAtFence === validated.lease.runtimeFence))))
  )
}
