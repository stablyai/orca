import { randomUUID } from 'node:crypto'

import type { AgentStatusIpcPayload } from './agent-status-types'
import type { ExecutionHostId } from './execution-host'
import {
  AGENT_STATUS_STORE_REPLICA_BUFFER_MAX,
  agentStatusStoreRowIdentity,
  agentStatusStoreRowKey,
  type AgentStatusStoreChange,
  type AgentStatusStoreDelta,
  type AgentStatusStoreFrame,
  type AgentStatusStoreRowIdentity,
  type AgentStatusStoreSnapshot
} from './agent-status-store-replication'

export type AgentStatusStoreSourceMutation = {
  before: AgentStatusStoreRowIdentity | null
  after: AgentStatusStoreRowIdentity | null
}

export type AgentStatusStoreSource = {
  getSnapshot(): AgentStatusIpcPayload[]
  getRowsForPane(paneKey: string): AgentStatusIpcPayload[]
  subscribeMutations(listener: (mutation: AgentStatusStoreSourceMutation) => void): () => void
}

export type AgentStatusStorePublisherOptions = {
  executionHostId: ExecutionHostId
  source: AgentStatusStoreSource
  ownerEpoch?: string
  bufferMax?: number
  snapshotAttempts?: number
}

type Subscriber = {
  emit: (frame: AgentStatusStoreFrame) => void
  buffering: boolean
  overflowed: boolean
  buffered: AgentStatusStoreDelta[]
}

function sameIdentity(
  left: AgentStatusStoreRowIdentity | null,
  right: AgentStatusStoreRowIdentity | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    agentStatusStoreRowKey(left) === agentStatusStoreRowKey(right)
  )
}

/** Adds delivery ordering to a semantic host store without becoming another status authority. */
export class AgentStatusStorePublisher {
  readonly executionHostId: ExecutionHostId
  readonly ownerEpoch: string
  private cursor = 0
  private readonly source: AgentStatusStoreSource
  private readonly bufferMax: number
  private readonly snapshotAttempts: number
  private readonly subscribers = new Set<Subscriber>()
  private readonly disposeSource: () => void

  constructor(options: AgentStatusStorePublisherOptions) {
    this.executionHostId = options.executionHostId
    this.ownerEpoch = options.ownerEpoch ?? randomUUID()
    this.source = options.source
    this.bufferMax = options.bufferMax ?? AGENT_STATUS_STORE_REPLICA_BUFFER_MAX
    this.snapshotAttempts = options.snapshotAttempts ?? 3
    this.disposeSource = this.source.subscribeMutations((mutation) =>
      this.publishMutation(mutation)
    )
  }

  subscribe(emit: (frame: AgentStatusStoreFrame) => void): () => void {
    const subscriber: Subscriber = {
      emit,
      buffering: true,
      overflowed: false,
      buffered: []
    }
    // Register before census so a mutation can never fall between inventory and streaming.
    this.subscribers.add(subscriber)
    const snapshot = this.captureSnapshot()
    if (subscriber.overflowed) {
      subscriber.emit({
        type: 'resnapshot-required',
        executionHostId: this.executionHostId,
        ownerEpoch: this.ownerEpoch,
        cursor: this.cursor,
        reason: 'overflow'
      })
      this.subscribers.delete(subscriber)
      return () => {}
    }
    subscriber.emit(snapshot)
    for (const delta of subscriber.buffered) {
      if (delta.cursor > snapshot.cursor) {
        subscriber.emit(delta)
      }
    }
    subscriber.buffered = []
    subscriber.buffering = false
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  snapshot(): AgentStatusStoreSnapshot {
    return this.captureSnapshot()
  }

  dispose(): void {
    this.disposeSource()
    this.subscribers.clear()
  }

  private captureSnapshot(): AgentStatusStoreSnapshot {
    let rows: AgentStatusIpcPayload[] = []
    let boundary = this.cursor
    let complete = false
    for (let attempt = 0; attempt < this.snapshotAttempts; attempt += 1) {
      boundary = this.cursor
      rows = this.source.getSnapshot()
      if (this.cursor === boundary) {
        complete = true
        break
      }
    }
    return {
      type: 'snapshot',
      executionHostId: this.executionHostId,
      ownerEpoch: this.ownerEpoch,
      cursor: boundary,
      complete,
      rows
    }
  }

  private publishMutation(mutation: AgentStatusStoreSourceMutation): void {
    const changes: AgentStatusStoreChange[] = []
    if (mutation.before && !sameIdentity(mutation.before, mutation.after)) {
      changes.push({ type: 'drop', identity: mutation.before })
    }
    if (mutation.after) {
      const rows = this.source.getRowsForPane(mutation.after.paneKey)
      const requestedKey = agentStatusStoreRowKey(mutation.after)
      for (const row of rows) {
        if (
          !mutation.after.runId ||
          agentStatusStoreRowKey(agentStatusStoreRowIdentity(row)) === requestedKey
        ) {
          changes.push({ type: 'set', row })
        }
      }
    } else if (mutation.before && changes.length === 0) {
      changes.push({ type: 'drop', identity: mutation.before })
    }
    if (changes.length === 0) {
      return
    }
    const previousCursor = this.cursor
    this.cursor += 1
    const delta: AgentStatusStoreDelta = {
      type: 'delta',
      executionHostId: this.executionHostId,
      ownerEpoch: this.ownerEpoch,
      previousCursor,
      cursor: this.cursor,
      changes
    }
    for (const subscriber of this.subscribers) {
      if (!subscriber.buffering) {
        subscriber.emit(delta)
        continue
      }
      if (subscriber.buffered.length >= this.bufferMax) {
        subscriber.overflowed = true
        subscriber.buffered = []
        continue
      }
      subscriber.buffered.push(delta)
    }
  }
}
