import { AGENT_STATUS_STORE_LIMITS } from './agent-status-store-contract'
import { normalizeAgentStatusPayload, type AgentStatusIpcPayload } from './agent-status-types'
import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'

export const AGENT_STATUS_STORE_REPLICA_CAPABILITY = 'agent-status.store-replica.v1' as const
export const AGENT_STATUS_STORE_REPLICA_BUFFER_MAX = 256
/** Peer-defect guard on one frame's entry count, not an inventory limit. The main hook server's pane
 *  map is uncapped, so no constant here can bound a legitimate census; this only has to sit clear of
 *  the largest bound that is actually enforced, so a frame that reaches it is malformed or hostile.
 *  Derived rather than literal because that bound and this ceiling live in different files. */
export const AGENT_STATUS_STORE_FRAME_ENTRIES_MAX = AGENT_STATUS_STORE_LIMITS.parents * 2
export const AGENT_STATUS_STORE_FRAME_NOTIFICATION = 'agentStatus.storeFrame' as const
export const AGENT_STATUS_STORE_SUBSCRIBE_METHOD = 'agentStatus.subscribeStore' as const
export const AGENT_STATUS_STORE_SNAPSHOT_METHOD = 'agentStatus.getStoreSnapshot' as const

export type AgentStatusStoreRowIdentity = {
  paneKey: string
  runId?: string
}

export type AgentStatusStoreSet = {
  type: 'set'
  row: AgentStatusIpcPayload
}

export type AgentStatusStoreDrop = {
  type: 'drop'
  identity: AgentStatusStoreRowIdentity
}

export type AgentStatusStoreChange = AgentStatusStoreSet | AgentStatusStoreDrop

type AgentStatusStoreFrameBase = {
  executionHostId: ExecutionHostId
  ownerEpoch: string
}

export type AgentStatusStoreSnapshot = AgentStatusStoreFrameBase & {
  type: 'snapshot'
  cursor: number
  complete: boolean
  rows: AgentStatusIpcPayload[]
}

export type AgentStatusStoreDelta = AgentStatusStoreFrameBase & {
  type: 'delta'
  previousCursor: number
  cursor: number
  changes: AgentStatusStoreChange[]
}

export type AgentStatusStoreResnapshotRequired = AgentStatusStoreFrameBase & {
  type: 'resnapshot-required'
  cursor: number
  reason: 'gap' | 'overflow' | 'owner-restart'
}

export type AgentStatusStoreFrame =
  | AgentStatusStoreSnapshot
  | AgentStatusStoreDelta
  | AgentStatusStoreResnapshotRequired

export type AgentStatusStoreReplicaContact = 'live' | 'unverifiable'

export type AgentStatusStoreReplicaHostSnapshot = {
  executionHostId: ExecutionHostId
  ownerEpoch: string | null
  cursor: number | null
  membershipConfirmed: boolean
  contact: AgentStatusStoreReplicaContact
  rows: AgentStatusIpcPayload[]
}

export type AgentStatusStoreReplicaApplyResult = 'applied' | 'ignored-stale' | 'resnapshot-required'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCursor(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isRowIdentity(value: unknown): value is AgentStatusStoreRowIdentity {
  return (
    isRecord(value) &&
    typeof value.paneKey === 'string' &&
    value.paneKey.length > 0 &&
    (value.runId === undefined || typeof value.runId === 'string')
  )
}

/** Keep the normalizer's output. It truncates and sanitizes every free-text field, so calling it
 *  only as a predicate leaves a remote host's caps unenforced on the rows we hand to readers. */
function normalizedStatusRow(row: AgentStatusIpcPayload): AgentStatusIpcPayload {
  const payload = normalizeAgentStatusPayload(row)
  return payload ? { ...row, ...payload } : row
}

function isStatusRow(value: unknown): value is AgentStatusIpcPayload {
  return (
    isRecord(value) &&
    typeof value.paneKey === 'string' &&
    value.paneKey.length > 0 &&
    (value.connectionId === null || typeof value.connectionId === 'string') &&
    typeof value.receivedAt === 'number' &&
    Number.isFinite(value.receivedAt) &&
    typeof value.stateStartedAt === 'number' &&
    Number.isFinite(value.stateStartedAt) &&
    normalizeAgentStatusPayload(value) !== null
  )
}

/** Validates replication frames at transport boundaries before they can mutate a replica. */
export function isAgentStatusStoreFrame(value: unknown): value is AgentStatusStoreFrame {
  if (
    !isRecord(value) ||
    normalizeExecutionHostId(
      typeof value.executionHostId === 'string' ? value.executionHostId : undefined
    ) !== value.executionHostId ||
    typeof value.ownerEpoch !== 'string' ||
    value.ownerEpoch.length === 0 ||
    value.ownerEpoch.length > 128 ||
    !isCursor(value.cursor)
  ) {
    return false
  }
  if (value.type === 'snapshot') {
    return (
      typeof value.complete === 'boolean' &&
      Array.isArray(value.rows) &&
      value.rows.length <= AGENT_STATUS_STORE_FRAME_ENTRIES_MAX &&
      value.rows.every(isStatusRow)
    )
  }
  if (value.type === 'resnapshot-required') {
    return value.reason === 'gap' || value.reason === 'overflow' || value.reason === 'owner-restart'
  }
  if (
    value.type !== 'delta' ||
    !isCursor(value.previousCursor) ||
    !Array.isArray(value.changes) ||
    value.changes.length > AGENT_STATUS_STORE_FRAME_ENTRIES_MAX
  ) {
    return false
  }
  return value.changes.every(
    (change) =>
      isRecord(change) &&
      ((change.type === 'set' && isStatusRow(change.row)) ||
        (change.type === 'drop' && isRowIdentity(change.identity)))
  )
}

export function agentStatusStoreRowKey(identity: AgentStatusStoreRowIdentity): string {
  return identity.runId ? `run\0${identity.runId}` : `pane\0${identity.paneKey}`
}

export function agentStatusStoreRowIdentity(
  row: AgentStatusIpcPayload
): AgentStatusStoreRowIdentity {
  return row.runId ? { paneKey: row.paneKey, runId: row.runId } : { paneKey: row.paneKey }
}

type ReplicaHostState = {
  ownerEpoch: string | null
  cursor: number | null
  membershipConfirmed: boolean
  contact: AgentStatusStoreReplicaContact
  rows: Map<string, AgentStatusIpcPayload>
}

function newReplicaHostState(): ReplicaHostState {
  return {
    ownerEpoch: null,
    cursor: null,
    membershipConfirmed: false,
    contact: 'unverifiable',
    rows: new Map()
  }
}

/** In-memory projection of host-owned status. It never changes row semantics. */
export class AgentStatusStoreReplica {
  private readonly hosts = new Map<ExecutionHostId, ReplicaHostState>()

  apply(frame: AgentStatusStoreFrame): AgentStatusStoreReplicaApplyResult {
    const state = this.hosts.get(frame.executionHostId) ?? newReplicaHostState()
    this.hosts.set(frame.executionHostId, state)
    state.contact = 'live'

    if (frame.type === 'snapshot') {
      return this.applySnapshot(state, frame)
    }
    if (frame.type === 'resnapshot-required') {
      // The marker is authoritative about the publisher epoch. Reset the cursor as
      // well as membership so a stale delta from the prior owner cannot be accepted.
      state.ownerEpoch = frame.ownerEpoch
      state.cursor = null
      state.membershipConfirmed = false
      return 'resnapshot-required'
    }
    if (state.ownerEpoch !== frame.ownerEpoch) {
      state.ownerEpoch = frame.ownerEpoch
      state.cursor = null
      state.membershipConfirmed = false
      return 'resnapshot-required'
    }
    if (state.cursor !== null && frame.cursor <= state.cursor) {
      return 'ignored-stale'
    }
    if (state.cursor === null || frame.previousCursor !== state.cursor) {
      state.membershipConfirmed = false
      return 'resnapshot-required'
    }
    for (const change of frame.changes) {
      if (change.type === 'set') {
        state.rows.set(
          agentStatusStoreRowKey(agentStatusStoreRowIdentity(change.row)),
          normalizedStatusRow(change.row)
        )
      } else {
        state.rows.delete(agentStatusStoreRowKey(change.identity))
      }
    }
    state.cursor = frame.cursor
    return 'applied'
  }

  setContact(executionHostId: ExecutionHostId, contact: AgentStatusStoreReplicaContact): void {
    const state = this.hosts.get(executionHostId) ?? newReplicaHostState()
    this.hosts.set(executionHostId, state)
    state.contact = contact
  }

  /** Explicitly abandons one mirrored host without implying that any represented process exited. */
  abandonHost(executionHostId: ExecutionHostId): void {
    this.hosts.delete(executionHostId)
  }

  getHostSnapshot(executionHostId: ExecutionHostId): AgentStatusStoreReplicaHostSnapshot {
    const state = this.hosts.get(executionHostId) ?? newReplicaHostState()
    return {
      executionHostId,
      ownerEpoch: state.ownerEpoch,
      cursor: state.cursor,
      membershipConfirmed: state.membershipConfirmed,
      contact: state.contact,
      rows: Array.from(state.rows.values())
    }
  }

  getRows(): { executionHostId: ExecutionHostId; row: AgentStatusIpcPayload }[] {
    const rows: { executionHostId: ExecutionHostId; row: AgentStatusIpcPayload }[] = []
    for (const [executionHostId, state] of this.hosts) {
      for (const row of state.rows.values()) {
        rows.push({ executionHostId, row })
      }
    }
    return rows
  }

  private applySnapshot(
    state: ReplicaHostState,
    snapshot: AgentStatusStoreSnapshot
  ): AgentStatusStoreReplicaApplyResult {
    const sameOwner = state.ownerEpoch === snapshot.ownerEpoch
    if (sameOwner && state.cursor !== null && snapshot.cursor < state.cursor) {
      return 'ignored-stale'
    }
    if (!sameOwner) {
      state.ownerEpoch = snapshot.ownerEpoch
      state.membershipConfirmed = false
    }
    if (snapshot.complete) {
      state.rows.clear()
    }
    for (const row of snapshot.rows) {
      state.rows.set(
        agentStatusStoreRowKey(agentStatusStoreRowIdentity(row)),
        normalizedStatusRow(row)
      )
    }
    state.cursor = snapshot.cursor
    state.membershipConfirmed = snapshot.complete
    return 'applied'
  }
}
