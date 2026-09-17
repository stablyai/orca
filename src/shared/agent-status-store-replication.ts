import type { AgentStatusIpcPayload } from './agent-status-types'
import type { ExecutionHostId } from './execution-host'

export const AGENT_STATUS_STORE_REPLICA_CAPABILITY = 'agent-status.store-replica.v1' as const
export const AGENT_STATUS_STORE_REPLICA_BUFFER_MAX = 256
export const AGENT_STATUS_STORE_FRAME_NOTIFICATION = 'agentStatus.storeFrame' as const

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
        state.rows.set(agentStatusStoreRowKey(agentStatusStoreRowIdentity(change.row)), change.row)
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
      state.rows.set(agentStatusStoreRowKey(agentStatusStoreRowIdentity(row)), row)
    }
    state.cursor = snapshot.cursor
    state.membershipConfirmed = snapshot.complete
    return 'applied'
  }
}
