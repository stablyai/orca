import type { AgentChildWorkAliasRecord } from './agent-status-child-work-alias'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import {
  AGENT_STATUS_STORE_LIMITS,
  AGENT_STATUS_STORE_SNAPSHOT_VERSION,
  type AgentStatusFactRecord,
  type AgentStatusStoreSnapshot,
  type AgentStatusTombstoneRecord
} from './agent-status-store-contract'
import type { AgentStatusParentRecord } from './agent-status-store-parent'
import type { AgentStatusStoreState } from './agent-status-store-state'
import { measureUtf8ByteLength } from './utf8-byte-limits'

/** Either the snapshot header or a single owner/record measured while accumulating the budget. */
type AgentStatusStoreByteBudgetRecord =
  | AgentStatusStoreSnapshot
  | AgentStatusParentRecord
  | AgentChildWorkRecord
  | AgentChildWorkAliasRecord
  | AgentStatusFactRecord
  | AgentStatusTombstoneRecord

const recordBytes = new WeakMap<AgentStatusStoreByteBudgetRecord, number>()

function serializedBytes(record: AgentStatusStoreByteBudgetRecord): number {
  const cached = recordBytes.get(record)
  if (cached !== undefined) {
    return cached
  }
  const bytes = measureUtf8ByteLength(JSON.stringify(record)).byteLength
  if (Object.isFrozen(record)) {
    recordBytes.set(record, bytes)
  }
  return bytes
}

/** Enforce the complete snapshot budget before commit without allocating a full snapshot. */
export function agentStatusStoreFitsByteBudget(state: AgentStatusStoreState): boolean {
  let bytes = serializedBytes({
    version: AGENT_STATUS_STORE_SNAPSHOT_VERSION,
    epoch: state.epoch,
    revision: state.revision,
    parents: [],
    children: [],
    aliases: [],
    facts: [],
    tombstones: []
  })
  for (const records of [
    state.parents,
    state.children,
    state.aliases,
    state.facts,
    state.tombstones
  ]) {
    bytes += Math.max(0, records.size - 1)
    for (const record of records.values()) {
      bytes += serializedBytes(record)
      if (bytes > AGENT_STATUS_STORE_LIMITS.serializedBytes) {
        return false
      }
    }
  }
  return bytes <= AGENT_STATUS_STORE_LIMITS.serializedBytes
}
