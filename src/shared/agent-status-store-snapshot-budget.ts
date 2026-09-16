import {
  AGENT_STATUS_STORE_LIMITS,
  AGENT_STATUS_STORE_SNAPSHOT_VERSION
} from './agent-status-store-contract'
import type { AgentChildWorkAliasRecord } from './agent-status-child-work-alias'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import type {
  AgentStatusFactRecord,
  AgentStatusTombstoneRecord
} from './agent-status-store-contract'
import type { AgentStatusParentRecord } from './agent-status-store-parent'
import type { AgentStatusStoreState } from './agent-status-store-state'
import { getUtf8ByteLength } from './utf8-byte-limits'

type AgentStatusSnapshotRecord =
  | AgentStatusParentRecord
  | AgentChildWorkRecord
  | AgentChildWorkAliasRecord
  | AgentStatusFactRecord
  | AgentStatusTombstoneRecord

const snapshotRecordByteLengths = new WeakMap<AgentStatusSnapshotRecord, number>()

function getSnapshotRecordByteLength(record: AgentStatusSnapshotRecord): number {
  const cached = snapshotRecordByteLengths.get(record)
  if (cached !== undefined) {
    return cached
  }
  const byteLength = getUtf8ByteLength(JSON.stringify(record))
  snapshotRecordByteLengths.set(record, byteLength)
  return byteLength
}

function getSnapshotCollectionEntryBytes(records: Iterable<AgentStatusSnapshotRecord>): number {
  let byteLength = 0
  let count = 0
  for (const record of records) {
    byteLength += getSnapshotRecordByteLength(record)
    count += 1
  }
  return byteLength + Math.max(0, count - 1)
}

export function isAgentStatusStoreSnapshotWithinByteLimit(state: AgentStatusStoreState): boolean {
  const emptySnapshot = {
    version: AGENT_STATUS_STORE_SNAPSHOT_VERSION,
    epoch: state.epoch,
    revision: state.revision,
    parents: [],
    children: [],
    aliases: [],
    facts: [],
    tombstones: []
  }
  let byteLength = getUtf8ByteLength(JSON.stringify(emptySnapshot))
  const collections: Iterable<AgentStatusSnapshotRecord>[] = [
    state.parents.values(),
    state.children.values(),
    state.aliases.values(),
    state.facts.values(),
    state.tombstones.values()
  ]
  for (const records of collections) {
    byteLength += getSnapshotCollectionEntryBytes(records)
    if (byteLength > AGENT_STATUS_STORE_LIMITS.serializedBytes) {
      return false
    }
  }
  return true
}
