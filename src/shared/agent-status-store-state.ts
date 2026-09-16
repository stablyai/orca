import {
  deserializeAgentChildWorkAliasKey,
  parseAgentChildWorkAliasRecord,
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  agentChildWorkBelongsTo,
  agentChildWorkFencesEqual,
  type AgentChildWorkRecord
} from './agent-status-child-work'
import { parseAgentChildWorkRecord } from './agent-status-child-work-codec'
import {
  AGENT_STATUS_STORE_LIMITS,
  AGENT_STATUS_STORE_SNAPSHOT_VERSION,
  AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS,
  type AgentStatusFactIdentity,
  type AgentStatusFactRecord,
  type AgentStatusStoreSnapshot,
  type AgentStatusTombstoneEntity,
  type AgentStatusTombstoneRecord
} from './agent-status-store-contract'
import {
  parseAgentStatusStoreSnapshot,
  parseAgentStatusTombstoneRecord
} from './agent-status-store-codec'
import {
  deserializeAgentStatusFactKey,
  parseAgentStatusFactRecord,
  serializeAgentStatusFactKey
} from './agent-status-store-fact-codec'
import {
  parseAgentStatusParentRecord,
  type AgentStatusParentRecord
} from './agent-status-store-parent'
import { isAgentStatusStoreSnapshotWithinByteLimit } from './agent-status-store-snapshot-budget'
import { deserializeAgentStatusSubject, serializeAgentStatusSubject } from './agent-status-subject'

export type AgentStatusStoreState = {
  epoch: string
  revision: number
  parents: Map<string, AgentStatusParentRecord>
  children: Map<string, AgentChildWorkRecord>
  aliases: Map<string, AgentChildWorkAliasRecord>
  facts: Map<string, AgentStatusFactRecord>
  tombstones: Map<string, AgentStatusTombstoneRecord>
}

export function deepFreezeAgentStatusStoreValue<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) {
    deepFreezeAgentStatusStoreValue(nested)
  }
  return Object.freeze(value)
}

export function agentStatusFactMapKey(fact: AgentStatusFactIdentity): string {
  return serializeAgentStatusFactKey(fact)
}

export function agentStatusTombstoneMapKey(
  entity: AgentStatusTombstoneEntity,
  key: string
): string {
  return `${entity}\0${key}`
}

export function createEmptyAgentStatusStoreState(epoch: string): AgentStatusStoreState {
  return {
    epoch,
    revision: 0,
    parents: new Map(),
    children: new Map(),
    aliases: new Map(),
    facts: new Map(),
    tombstones: new Map()
  }
}

export function cloneAgentStatusStoreState(state: AgentStatusStoreState): AgentStatusStoreState {
  return {
    epoch: state.epoch,
    revision: state.revision,
    parents: new Map(state.parents),
    children: new Map(state.children),
    aliases: new Map(state.aliases),
    facts: new Map(state.facts),
    tombstones: new Map(state.tombstones)
  }
}

function snapshotCandidateFromAgentStatusStoreState(state: AgentStatusStoreState) {
  return {
    version: AGENT_STATUS_STORE_SNAPSHOT_VERSION,
    epoch: state.epoch,
    revision: state.revision,
    parents: [...state.parents.values()],
    children: [...state.children.values()],
    aliases: [...state.aliases.values()],
    facts: [...state.facts.values()],
    tombstones: [...state.tombstones.values()]
  }
}

function hasMatchingFence(child: AgentChildWorkRecord, alias: AgentChildWorkAliasRecord): boolean {
  if (agentChildWorkFencesEqual(child.invocation, alias.fence)) {
    return true
  }
  return (
    child.previousInvocations?.some((entry) =>
      agentChildWorkFencesEqual(entry.fence, alias.fence)
    ) === true
  )
}

export function validateAgentStatusStoreState(state: AgentStatusStoreState): boolean {
  if (
    state.parents.size > AGENT_STATUS_STORE_LIMITS.parents ||
    state.children.size > AGENT_STATUS_STORE_LIMITS.children ||
    state.aliases.size > AGENT_STATUS_STORE_LIMITS.aliases ||
    state.facts.size > AGENT_STATUS_STORE_LIMITS.facts ||
    state.tombstones.size > AGENT_STATUS_STORE_LIMITS.tombstones
  ) {
    return false
  }
  for (const [key, parent] of state.parents) {
    if (
      key !== serializeAgentStatusSubject(parent.subject) ||
      parent.revision > state.revision ||
      (state.tombstones.get(agentStatusTombstoneMapKey('parent', key))?.revision ?? -1) >=
        parent.revision
    ) {
      return false
    }
  }
  for (const [childWorkId, child] of state.children) {
    if (
      childWorkId !== child.childWorkId ||
      child.revision > state.revision ||
      !state.parents.has(serializeAgentStatusSubject(child.parent)) ||
      state.tombstones.has(agentStatusTombstoneMapKey('child', childWorkId))
    ) {
      return false
    }
  }
  for (const [key, alias] of state.aliases) {
    const child = state.children.get(alias.childWorkId)
    const tombstone = state.tombstones.get(agentStatusTombstoneMapKey('alias', key))
    if (
      key !== serializeAgentChildWorkAliasKey(alias) ||
      alias.revision > state.revision ||
      !child ||
      !agentChildWorkBelongsTo(child, alias.parent) ||
      child.provider !== alias.provider ||
      child.kind !== alias.kind ||
      !hasMatchingFence(child, alias) ||
      (tombstone !== undefined && tombstone.revision >= alias.revision)
    ) {
      return false
    }
  }
  for (const [key, fact] of state.facts) {
    const tombstone = state.tombstones.get(agentStatusTombstoneMapKey('fact', key))
    if (
      key !== agentStatusFactMapKey(fact) ||
      fact.revision > state.revision ||
      !state.parents.has(serializeAgentStatusSubject(fact.subject)) ||
      (tombstone !== undefined && tombstone.revision >= fact.revision)
    ) {
      return false
    }
  }
  for (const item of state.tombstones.values()) {
    if (
      item.revision > state.revision ||
      (item.entity === 'parent' && !deserializeAgentStatusSubject(item.key)) ||
      (item.entity === 'alias' && !deserializeAgentChildWorkAliasKey(item.key)) ||
      (item.entity === 'fact' && !deserializeAgentStatusFactKey(item.key))
    ) {
      return false
    }
  }
  return isAgentStatusStoreSnapshotWithinByteLimit(state)
}

export function snapshotFromAgentStatusStoreState(
  state: AgentStatusStoreState
): AgentStatusStoreSnapshot {
  const snapshot = parseAgentStatusStoreSnapshot(snapshotCandidateFromAgentStatusStoreState(state))
  if (!snapshot) {
    throw new Error('Agent status store produced an invalid snapshot')
  }
  return deepFreezeAgentStatusStoreValue(snapshot)
}

export function agentStatusStoreStateFromSnapshot(
  snapshot: AgentStatusStoreSnapshot,
  epoch: string
): AgentStatusStoreState | null {
  const state = createEmptyAgentStatusStoreState(epoch)
  state.revision = snapshot.revision
  for (const parent of snapshot.parents) {
    const record = parseAgentStatusParentRecord(parent)
    if (!record) {
      return null
    }
    const key = serializeAgentStatusSubject(record.subject)
    if (state.parents.has(key)) {
      return null
    }
    state.parents.set(key, deepFreezeAgentStatusStoreValue(record))
  }
  for (const child of snapshot.children) {
    const record = parseAgentChildWorkRecord(child)
    if (!record || state.children.has(record.childWorkId)) {
      return null
    }
    state.children.set(record.childWorkId, deepFreezeAgentStatusStoreValue(record))
  }
  for (const alias of snapshot.aliases) {
    const record = parseAgentChildWorkAliasRecord(alias)
    if (!record) {
      return null
    }
    const key = serializeAgentChildWorkAliasKey(record)
    if (state.aliases.has(key)) {
      return null
    }
    state.aliases.set(key, deepFreezeAgentStatusStoreValue(record))
  }
  for (const fact of snapshot.facts) {
    const record = parseAgentStatusFactRecord(fact)
    if (!record) {
      return null
    }
    const key = agentStatusFactMapKey(record)
    if (state.facts.has(key)) {
      return null
    }
    state.facts.set(key, deepFreezeAgentStatusStoreValue(record))
  }
  for (const tombstone of [...snapshot.tombstones].sort(
    (left, right) => left.revision - right.revision
  )) {
    const record = parseAgentStatusTombstoneRecord(tombstone)
    if (!record) {
      return null
    }
    const key = agentStatusTombstoneMapKey(record.entity, record.key)
    if (state.tombstones.has(key)) {
      return null
    }
    state.tombstones.set(key, deepFreezeAgentStatusStoreValue(record))
  }
  for (const [key, tombstone] of state.tombstones) {
    if (state.revision - tombstone.revision < AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS) {
      break
    }
    state.tombstones.delete(key)
  }
  return validateAgentStatusStoreState(state) ? state : null
}
