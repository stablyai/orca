import { isAgentSessionRewindRecord, type AgentSessionRewindRecord } from './agent-session-rewind'
import { isAgentSessionConversationName } from './agent-session-conversation-name'
import {
  isPersistedAgentSessionHandoffStage,
  isPersistedAgentSessionRuntimeKind,
  type PersistedAgentSessionLease,
  type PersistedAgentSessionRecord
} from './agent-session-legacy-handoff-lease'
/**
 * Durable agent-session record and its single-writer lease.
 *
 * The record is the session's identity — where it runs, which provider it talks to, which account
 * home is pinned to it — and is independent of any terminal tab. The lease is the separate
 * question of which process is currently allowed to write to it.
 */

import type { ExecutionHostId } from './execution-host'
import {
  isAgentSessionConversationCommandRecord,
  type AgentSessionConversationCommandRecord
} from './agent-session-conversation-command'
import {
  decodePersistedAgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import {
  isAgentSessionProviderHandleInNamespace,
  isStructuredAgentId
} from './agent-session-provider-handle-encoding'
import {
  isAgentSessionAccountHome,
  MAX_PATH_LENGTH,
  type AgentSessionAccountHome
} from './agent-session-account-home'

export type { AgentSessionAccountHome } from './agent-session-account-home'

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

/** Provider launch environment captured by the host when the session is created. */
export type AgentSessionLaunchEnv = Record<string, string>

/** Still persisted because older builds read it. The removed terminal handoff's `tui` is mapped
 *  away at decode (agent-session-legacy-handoff-lease). */
export type AgentSessionOwnerRuntimeKind = 'native'

/** The acquisition stage. Stages only older builds wrote are mapped away at decode. */
export type AgentSessionHandoffStage = 'new-owner-proving' | 'recovering'

/**
 * PID-reuse-safe process identity. `spawnToken` is the only element available on every platform:
 * process start time costs a CIM query on Windows and is absent in some containers.
 */
export type AgentSessionProcessIdentity = {
  hostId: string
  pid: number
  processStartTimeMs: number | null
  spawnToken: string
  /** The Orca runtime that started this process and holds its transport, stamped when the owner is
   *  recorded; absent on owners older builds recorded. */
  runtime?: string
}

export type AgentSessionJournalCheckpoint = { epoch: number; sequence: number }

/**
 * `released` means no owner: a durable record that outlives its owner needs a name for that.
 * `conflicted` is how a terminal owner an older build recorded loads: recovery waits it out and
 * never stops it, because it is the user's own agent.
 */
export type AgentSessionClaimStatus = 'reserved' | 'live' | 'conflicted' | 'released'

export type AgentSessionDeathEvidence = {
  kind: 'exit-observed' | 'pid-absent' | 'identity-mismatch'
  detail: string
  observedAt: number
  /** Fence of the owner (or reservation) this death is about; a fence names exactly one. Absent on
   *  evidence older builds wrote, which then speaks for no turn. */
  ownerFence?: number
  /** The death interval's lower bound: the last time the runtime holding the owner's transport
   *  proved it alive. Only a probe's proof records it: absent on a surface-release exit, a failed
   *  start, and evidence older builds wrote. */
  lastProvenAliveAt?: number
  /** How the Orca runtime that held the owner ended, when the owner died with it: the quit or
   *  update it had begun, else 'crash'. Absent when a provider died on its own while Orca ran, and
   *  whenever that cannot be told. A string, since a newer build may write a cause this one does
   *  not know; read it with `isAgentSessionOrcaStopCause`. */
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
  journalCheckpoint: AgentSessionJournalCheckpoint | null
  /** Key id that minted the HMAC claim this lease was granted under. */
  claimKeyId: string
  claimStatus: AgentSessionClaimStatus
  /** True from load until the host adjudicates it; no writer is granted while set. */
  unreconciled: boolean
  /**
   * Lowest fence a future grant may use. Set only by an earlier build's import of its records file,
   * when the copy came from its backup or sat beside a set-aside copy of the same chat: either may
   * hide a fence already granted. The CURRENT fence is deliberately left alone: `live` means a
   * handle proven at exactly that number, so rewriting it would invalidate the record it is trying
   * to save.
   */
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
  accountHome: AgentSessionAccountHome
  /** The directory the provider first launched in, in the execution host's path syntax. Floating
   *  sessions resume here; worktree and folder ids still resolve by id to their durable place. */
  launchDirectory?: string
  /** Provider options the user chose, replayed whenever a new owner starts the session. */
  options?: Record<string, string>
  rewind?: AgentSessionRewindRecord
  conversationCommand?: AgentSessionConversationCommandRecord
  /** The name Orca gave this conversation, so a later acquisition need not name it again. */
  conversationName?: string
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
    (lease.journalCheckpoint === null ||
      isAgentSessionJournalCheckpoint(lease.journalCheckpoint)) &&
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
    (record.rewind === undefined || isAgentSessionRewindRecord(record.rewind)) &&
    (record.conversationCommand === undefined ||
      isAgentSessionConversationCommandRecord(record.conversationCommand)) &&
    (record.conversationName === undefined ||
      isAgentSessionConversationName(record.conversationName)) &&
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
  // One namespace, owned by the record's own agent; which transport is the chain's own fact.
  const transport = chain?.[0]?.handle.transport
  const namespace = transport === undefined ? null : { transport, agent: validated.provider }
  return (
    chain !== null &&
    chain.every(
      (link) =>
        namespace !== null && isAgentSessionProviderHandleInNamespace(link.handle, namespace)
    ) &&
    (validated.lease.claimStatus !== 'live' ||
      (validated.lease.ownerProcess !== null &&
        head?.linkId === validated.lease.provenHandleLinkId &&
        head.mintedAtFence === validated.lease.runtimeFence))
  )
}
