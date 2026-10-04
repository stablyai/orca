import { parseAgentChildWorkAliasRecord } from './agent-status-child-work-alias'
import type { AgentChildWorkAliasRecord } from './agent-status-child-work-alias'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import {
  deserializeAgentChildWorkBindingKey,
  serializeAgentChildWorkBindingKey
} from './agent-status-child-work-binding'
import { parseAgentChildWorkRecord } from './agent-status-child-work-codec'
import type {
  AgentStatusFactRecord,
  AgentStatusStoreMutation,
  AgentStatusTombstoneEntity,
  AgentStatusTombstoneRecord
} from './agent-status-store-contract'
import {
  AGENT_STATUS_STORE_LIMITS,
  AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS
} from './agent-status-store-contract'
import { parseAgentStatusFactRecord } from './agent-status-store-fact-codec'
import {
  parseAgentStatusParentRecord,
  type AgentStatusParentRecord
} from './agent-status-store-parent'
import {
  agentStatusFactMapKey,
  agentStatusTombstoneMapKey,
  deepFreezeAgentStatusStoreValue
} from './agent-status-store-state'
import type { AgentStatusStoreTable } from './agent-status-store-table'
import {
  deserializeAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusSubject
} from './agent-status-subject'

/** The store as one mutation reads and writes it. The queries return present keys in map order. */
export type AgentStatusStoreMutationTables = {
  revision: number
  parents: AgentStatusStoreTable<AgentStatusParentRecord>
  children: AgentStatusStoreTable<AgentChildWorkRecord>
  aliases: AgentStatusStoreTable<AgentChildWorkAliasRecord>
  facts: AgentStatusStoreTable<AgentStatusFactRecord>
  tombstones: AgentStatusStoreTable<AgentStatusTombstoneRecord>
  childrenOf(parentKey: string): string[]
  factsOf(parentKey: string): string[]
  aliasesOfChildren(childWorkIds: ReadonlySet<string>): string[]
}

type Tables = AgentStatusStoreMutationTables

function addTombstone(
  state: Tables,
  entity: AgentStatusTombstoneEntity,
  key: string,
  revision: number
): void {
  const record = deepFreezeAgentStatusStoreValue({ entity, key, revision })
  const mapKey = agentStatusTombstoneMapKey(entity, key)
  state.tombstones.delete(mapKey)
  state.tombstones.set(mapKey, record)
}

function compactTombstones(state: Tables): void {
  for (const [key, tombstone] of state.tombstones.entries()) {
    if (
      state.tombstones.size <= AGENT_STATUS_STORE_LIMITS.tombstones &&
      state.revision - tombstone.revision < AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS
    ) {
      break
    }
    state.tombstones.delete(key)
  }
}

function removeAlias(state: Tables, key: string, revision: number): void {
  state.aliases.delete(key)
  addTombstone(state, 'alias', key, revision)
}

function removeFact(state: Tables, key: string, revision: number): void {
  state.facts.delete(key)
  addTombstone(state, 'fact', key, revision)
}

function removeChild(
  state: Tables,
  childWorkId: string,
  revision: number,
  removedChildWorkIds: Set<string>
): void {
  state.children.delete(childWorkId)
  addTombstone(state, 'child', childWorkId, revision)
  removedChildWorkIds.add(childWorkId)
}

function removeAliasesForChildren(
  state: Tables,
  removedChildWorkIds: ReadonlySet<string>,
  revision: number
): void {
  if (removedChildWorkIds.size === 0) {
    return
  }
  for (const key of state.aliasesOfChildren(removedChildWorkIds)) {
    removeAlias(state, key, revision)
  }
}

function removeParent(
  state: Tables,
  subject: AgentStatusSubject,
  revision: number,
  removedChildWorkIds: Set<string>
): void {
  const key = serializeAgentStatusSubject(subject)
  state.parents.delete(key)
  addTombstone(state, 'parent', key, revision)
  for (const childWorkId of state.childrenOf(key)) {
    removeChild(state, childWorkId, revision, removedChildWorkIds)
  }
  for (const factMapKey of state.factsOf(key)) {
    removeFact(state, factMapKey, revision)
  }
}

function applyExplicitTombstone(
  state: Tables,
  tombstone: { entity: AgentStatusTombstoneEntity; key: string },
  revision: number,
  removedChildWorkIds: Set<string>
): boolean {
  if (tombstone.entity === 'parent') {
    const subject = deserializeAgentStatusSubject(tombstone.key)
    if (!subject) {
      return false
    }
    removeParent(state, subject, revision, removedChildWorkIds)
    return true
  }
  if (tombstone.entity === 'child') {
    removeChild(state, tombstone.key, revision, removedChildWorkIds)
  } else if (tombstone.entity === 'alias') {
    if (!deserializeAgentChildWorkBindingKey(tombstone.key)) {
      return false
    }
    removeAlias(state, tombstone.key, revision)
  } else {
    removeFact(state, tombstone.key, revision)
  }
  addTombstone(state, tombstone.entity, tombstone.key, revision)
  return true
}

function upsertParent(
  state: Tables,
  input: NonNullable<AgentStatusStoreMutation['parent']>,
  revision: number
): boolean {
  const key = serializeAgentStatusSubject(input.subject)
  const tombstone = state.tombstones.get(agentStatusTombstoneMapKey('parent', key))
  if (tombstone && tombstone.revision >= revision) {
    return false
  }
  const previous = state.parents.get(key)
  const record = parseAgentStatusParentRecord({
    ...input,
    ...(input.firstObservedAt === undefined && previous?.firstObservedAt !== undefined
      ? { firstObservedAt: previous.firstObservedAt }
      : {}),
    revision
  })
  if (!record) {
    return false
  }
  state.parents.set(key, deepFreezeAgentStatusStoreValue(record))
  return true
}

function upsertChildren(
  state: Tables,
  children: NonNullable<AgentStatusStoreMutation['children']>,
  revision: number
): boolean {
  for (const input of children) {
    const previous = state.children.get(input.childWorkId)
    if (
      state.tombstones.has(agentStatusTombstoneMapKey('child', input.childWorkId)) ||
      !state.parents.has(serializeAgentStatusSubject(input.parent)) ||
      (previous !== undefined && previous.firstObservedAt !== input.firstObservedAt) ||
      (previous !== undefined && input.observedAt < previous.observedAt)
    ) {
      return false
    }
    const record = parseAgentChildWorkRecord({ ...input, revision })
    if (!record) {
      return false
    }
    state.children.set(input.childWorkId, deepFreezeAgentStatusStoreValue(record))
  }
  return true
}

function upsertAliases(
  state: Tables,
  aliases: NonNullable<AgentStatusStoreMutation['aliases']>,
  revision: number
): boolean {
  for (const input of aliases) {
    const record = parseAgentChildWorkAliasRecord({ ...input, revision })
    if (!record) {
      return false
    }
    state.aliases.set(
      serializeAgentChildWorkBindingKey(record),
      deepFreezeAgentStatusStoreValue(record)
    )
  }
  return true
}

function upsertFacts(
  state: Tables,
  facts: NonNullable<AgentStatusStoreMutation['facts']>,
  revision: number
): boolean {
  for (const input of facts) {
    const record = parseAgentStatusFactRecord({ ...input, revision })
    if (!record || !state.parents.has(serializeAgentStatusSubject(record.subject))) {
      return false
    }
    state.facts.set(agentStatusFactMapKey(record), deepFreezeAgentStatusStoreValue(record))
  }
  return true
}

/** Apply every step of one mutation; false when a step refuses. Invariants are checked after. */
export function applyAgentStatusStoreMutationSteps(
  state: Tables,
  mutation: AgentStatusStoreMutation,
  revision: number
): boolean {
  const removedChildWorkIds = new Set<string>()
  if (mutation.removeParent) {
    removeParent(state, mutation.removeParent, revision, removedChildWorkIds)
  }
  for (const childWorkId of mutation.removeChildren ?? []) {
    removeChild(state, childWorkId, revision, removedChildWorkIds)
  }
  for (const key of mutation.removeAliases ?? []) {
    if (!deserializeAgentChildWorkBindingKey(key)) {
      return false
    }
    removeAlias(state, key, revision)
  }
  for (const identity of mutation.removeFacts ?? []) {
    removeFact(state, agentStatusFactMapKey(identity), revision)
  }
  for (const tombstone of mutation.tombstones ?? []) {
    if (!applyExplicitTombstone(state, tombstone, revision, removedChildWorkIds)) {
      return false
    }
  }
  removeAliasesForChildren(state, removedChildWorkIds, revision)
  if (mutation.parent && !upsertParent(state, mutation.parent, revision)) {
    return false
  }
  if (mutation.children && !upsertChildren(state, mutation.children, revision)) {
    return false
  }
  if (mutation.aliases && !upsertAliases(state, mutation.aliases, revision)) {
    return false
  }
  if (mutation.facts && !upsertFacts(state, mutation.facts, revision)) {
    return false
  }
  compactTombstones(state)
  return true
}
