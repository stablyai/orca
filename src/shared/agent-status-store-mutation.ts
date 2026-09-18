import { parseAgentChildWorkAliasRecord } from './agent-status-child-work-alias'
import {
  deserializeAgentChildWorkBindingKey,
  serializeAgentChildWorkBindingKey
} from './agent-status-child-work-binding'
import { parseAgentChildWorkRecord } from './agent-status-child-work-codec'
import type {
  AgentStatusStoreMutation,
  AgentStatusTombstoneEntity
} from './agent-status-store-contract'
import {
  AGENT_STATUS_STORE_LIMITS,
  AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS
} from './agent-status-store-contract'
import { parseAgentStatusFactRecord } from './agent-status-store-fact-codec'
import { parseAgentStatusParentRecord } from './agent-status-store-parent'
import {
  agentStatusFactMapKey,
  agentStatusTombstoneFences,
  agentStatusTombstoneMapKey,
  cloneAgentStatusStoreState,
  deepFreezeAgentStatusStoreValue,
  validateAgentStatusStoreState,
  type AgentStatusStoreState
} from './agent-status-store-state'
import {
  agentStatusSubjectsEqual,
  deserializeAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusSubject
} from './agent-status-subject'

function addTombstone(
  state: AgentStatusStoreState,
  entity: AgentStatusTombstoneEntity,
  key: string,
  revision: number
): void {
  const record = deepFreezeAgentStatusStoreValue({ entity, key, revision })
  const mapKey = agentStatusTombstoneMapKey(entity, key)
  state.tombstones.delete(mapKey)
  state.tombstones.set(mapKey, record)
}

function compactTombstones(state: AgentStatusStoreState): void {
  for (const [key, tombstone] of state.tombstones) {
    if (
      state.tombstones.size <= AGENT_STATUS_STORE_LIMITS.tombstones &&
      state.revision - tombstone.revision < AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS
    ) {
      break
    }
    state.tombstones.delete(key)
  }
}

function removeAlias(state: AgentStatusStoreState, key: string, revision: number): void {
  state.aliases.delete(key)
  addTombstone(state, 'alias', key, revision)
}

function removeFact(state: AgentStatusStoreState, key: string, revision: number): void {
  state.facts.delete(key)
  addTombstone(state, 'fact', key, revision)
}

function removeChild(
  state: AgentStatusStoreState,
  childWorkId: string,
  revision: number,
  removedChildWorkIds: Set<string>
): void {
  state.children.delete(childWorkId)
  addTombstone(state, 'child', childWorkId, revision)
  removedChildWorkIds.add(childWorkId)
}

function removeAliasesForChildren(
  state: AgentStatusStoreState,
  removedChildWorkIds: ReadonlySet<string>,
  revision: number
): void {
  for (const [key, alias] of state.aliases) {
    if (removedChildWorkIds.has(alias.childWorkId)) {
      removeAlias(state, key, revision)
    }
  }
}

function removeParent(
  state: AgentStatusStoreState,
  subject: AgentStatusSubject,
  revision: number,
  removedChildWorkIds: Set<string>
): void {
  const key = serializeAgentStatusSubject(subject)
  state.parents.delete(key)
  addTombstone(state, 'parent', key, revision)
  for (const child of state.children.values()) {
    if (agentStatusSubjectsEqual(child.parent, subject)) {
      removeChild(state, child.childWorkId, revision, removedChildWorkIds)
    }
  }
  for (const [factMapKey, fact] of state.facts) {
    if (agentStatusSubjectsEqual(fact.subject, subject)) {
      removeFact(state, factMapKey, revision)
    }
  }
}

function applyExplicitTombstone(
  state: AgentStatusStoreState,
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
  state: AgentStatusStoreState,
  input: NonNullable<AgentStatusStoreMutation['parent']>,
  revision: number
): boolean {
  const key = serializeAgentStatusSubject(input.subject)
  if (agentStatusTombstoneFences(state, 'parent', key, revision)) {
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
  state: AgentStatusStoreState,
  children: NonNullable<AgentStatusStoreMutation['children']>,
  revision: number
): boolean {
  for (const input of children) {
    const previous = state.children.get(input.childWorkId)
    if (
      agentStatusTombstoneFences(state, 'child', input.childWorkId, revision) ||
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
  state: AgentStatusStoreState,
  aliases: NonNullable<AgentStatusStoreMutation['aliases']>,
  revision: number
): boolean {
  for (const input of aliases) {
    const record = parseAgentChildWorkAliasRecord({ ...input, revision })
    if (!record) {
      return false
    }
    const key = serializeAgentChildWorkBindingKey(record)
    if (agentStatusTombstoneFences(state, 'alias', key, revision)) {
      return false
    }
    state.aliases.set(key, deepFreezeAgentStatusStoreValue(record))
  }
  return true
}

function upsertFacts(
  state: AgentStatusStoreState,
  facts: NonNullable<AgentStatusStoreMutation['facts']>,
  revision: number
): boolean {
  for (const input of facts) {
    const record = parseAgentStatusFactRecord({ ...input, revision })
    if (!record || !state.parents.has(serializeAgentStatusSubject(record.subject))) {
      return false
    }
    const key = agentStatusFactMapKey(record)
    if (agentStatusTombstoneFences(state, 'fact', key, revision)) {
      return false
    }
    state.facts.set(key, deepFreezeAgentStatusStoreValue(record))
  }
  return true
}

export function applyAgentStatusStoreMutation(
  current: AgentStatusStoreState,
  mutation: AgentStatusStoreMutation,
  revision: number
): AgentStatusStoreState | null {
  const next = cloneAgentStatusStoreState(current)
  next.revision = revision
  const removedChildWorkIds = new Set<string>()
  if (mutation.removeParent) {
    removeParent(next, mutation.removeParent, revision, removedChildWorkIds)
  }
  for (const childWorkId of mutation.removeChildren ?? []) {
    removeChild(next, childWorkId, revision, removedChildWorkIds)
  }
  for (const key of mutation.removeAliases ?? []) {
    if (!deserializeAgentChildWorkBindingKey(key)) {
      return null
    }
    removeAlias(next, key, revision)
  }
  for (const identity of mutation.removeFacts ?? []) {
    removeFact(next, agentStatusFactMapKey(identity), revision)
  }
  for (const tombstone of mutation.tombstones ?? []) {
    if (!applyExplicitTombstone(next, tombstone, revision, removedChildWorkIds)) {
      return null
    }
  }
  removeAliasesForChildren(next, removedChildWorkIds, revision)
  if (mutation.parent && !upsertParent(next, mutation.parent, revision)) {
    return null
  }
  if (mutation.children && !upsertChildren(next, mutation.children, revision)) {
    return null
  }
  if (mutation.aliases && !upsertAliases(next, mutation.aliases, revision)) {
    return null
  }
  if (mutation.facts && !upsertFacts(next, mutation.facts, revision)) {
    return null
  }
  compactTombstones(next)
  return validateAgentStatusStoreState(next) ? next : null
}
