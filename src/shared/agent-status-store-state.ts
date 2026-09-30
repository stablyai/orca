import {
  parseAgentChildWorkAliasRecord,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import { serializeAgentChildWorkBindingKey } from './agent-status-child-work-binding'
import {
  agentChildWorkBelongsTo,
  agentChildWorkFencesEqual,
  type AgentChildWorkRecord
} from './agent-status-child-work'
import { parseAgentChildWorkRecord } from './agent-status-child-work-codec'
import { agentStatusStoreFitsByteBudget } from './agent-status-store-byte-budget'
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
  parseAgentStatusFactRecord,
  serializeAgentStatusFactKey
} from './agent-status-store-fact-codec'
import {
  parseAgentStatusParentRecord,
  type AgentStatusParentRecord
} from './agent-status-store-parent'
import { storedBindingKey, tombstoneKeyIsValid } from './agent-status-store-record-keys'
import { serializeAgentStatusSubject } from './agent-status-subject'

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

type Lookup<V> = { get(key: string): V | undefined; has(key: string): boolean }

/** What one record's validity depends on besides itself. */
export type AgentStatusStoreRecordLookups = {
  revision: number
  parents: Lookup<AgentStatusParentRecord>
  children: Lookup<AgentChildWorkRecord>
  tombstones: Lookup<AgentStatusTombstoneRecord>
}

export function agentStatusStoreSizesFit(sizes: {
  parents: { size: number }
  children: { size: number }
  aliases: { size: number }
  facts: { size: number }
  tombstones: { size: number }
}): boolean {
  return (
    sizes.parents.size <= AGENT_STATUS_STORE_LIMITS.parents &&
    sizes.children.size <= AGENT_STATUS_STORE_LIMITS.children &&
    sizes.aliases.size <= AGENT_STATUS_STORE_LIMITS.aliases &&
    sizes.facts.size <= AGENT_STATUS_STORE_LIMITS.facts &&
    sizes.tombstones.size <= AGENT_STATUS_STORE_LIMITS.tombstones
  )
}

export function storedParentIsValid(
  lookups: AgentStatusStoreRecordLookups,
  key: string,
  parent: AgentStatusParentRecord
): boolean {
  return (
    key === serializeAgentStatusSubject(parent.subject) &&
    parent.revision <= lookups.revision &&
    (lookups.tombstones.get(agentStatusTombstoneMapKey('parent', key))?.revision ?? -1) <
      parent.revision
  )
}

export function storedChildIsValid(
  lookups: AgentStatusStoreRecordLookups,
  childWorkId: string,
  child: AgentChildWorkRecord
): boolean {
  return (
    childWorkId === child.childWorkId &&
    child.revision <= lookups.revision &&
    lookups.parents.has(serializeAgentStatusSubject(child.parent)) &&
    !lookups.tombstones.has(agentStatusTombstoneMapKey('child', childWorkId))
  )
}

export function storedAliasIsValid(
  lookups: AgentStatusStoreRecordLookups,
  key: string,
  alias: AgentChildWorkAliasRecord
): boolean {
  const child = lookups.children.get(alias.childWorkId)
  const tombstone = lookups.tombstones.get(agentStatusTombstoneMapKey('alias', key))
  return (
    key === storedBindingKey(alias) &&
    alias.revision <= lookups.revision &&
    child !== undefined &&
    agentChildWorkBelongsTo(child, alias.parent) &&
    child.provider === alias.provider &&
    child.kind === alias.kind &&
    hasMatchingFence(child, alias) &&
    (tombstone === undefined || tombstone.revision < alias.revision)
  )
}

export function storedFactIsValid(
  lookups: AgentStatusStoreRecordLookups,
  key: string,
  fact: AgentStatusFactRecord
): boolean {
  const tombstone = lookups.tombstones.get(agentStatusTombstoneMapKey('fact', key))
  return (
    key === agentStatusFactMapKey(fact) &&
    fact.revision <= lookups.revision &&
    lookups.parents.has(serializeAgentStatusSubject(fact.subject)) &&
    (tombstone === undefined || tombstone.revision < fact.revision)
  )
}

export function storedTombstoneIsValid(
  lookups: Pick<AgentStatusStoreRecordLookups, 'revision'>,
  tombstone: AgentStatusTombstoneRecord
): boolean {
  return tombstone.revision <= lookups.revision && tombstoneKeyIsValid(tombstone)
}

/** Every invariant over the whole store: for snapshot restore, and the oracle mutations are held to. */
export function validateAgentStatusStoreState(state: AgentStatusStoreState): boolean {
  if (!agentStatusStoreSizesFit(state)) {
    return false
  }
  for (const [key, parent] of state.parents) {
    if (!storedParentIsValid(state, key, parent)) {
      return false
    }
  }
  for (const [childWorkId, child] of state.children) {
    if (!storedChildIsValid(state, childWorkId, child)) {
      return false
    }
  }
  for (const [key, alias] of state.aliases) {
    if (!storedAliasIsValid(state, key, alias)) {
      return false
    }
  }
  for (const [key, fact] of state.facts) {
    if (!storedFactIsValid(state, key, fact)) {
      return false
    }
  }
  for (const item of state.tombstones.values()) {
    if (!storedTombstoneIsValid(state, item)) {
      return false
    }
  }
  return agentStatusStoreFitsByteBudget(state)
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
    const key = serializeAgentChildWorkBindingKey(record)
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
