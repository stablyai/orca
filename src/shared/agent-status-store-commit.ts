// A mutation applied in place: its steps write into drafts over the committed maps, only what they
// touched is re-validated, and the drafts land together or not at all. The committed store was
// valid, so a record the mutation did not touch, and whose dependencies it did not touch, still is.

import type { AgentStatusStoreMutation } from './agent-status-store-contract'
import { agentStatusStoreHeaderBytes } from './agent-status-store-byte-budget'
import { AGENT_STATUS_STORE_LIMITS } from './agent-status-store-contract'
import {
  commitAgentStatusStoreIndexes,
  draftedRecordBytes,
  inMapOrder,
  type AgentStatusStoreDrafts,
  type AgentStatusStoreIndexes
} from './agent-status-store-indexes'
import {
  applyAgentStatusStoreMutationSteps,
  type AgentStatusStoreMutationTables
} from './agent-status-store-mutation'
import {
  agentStatusStoreSizesFit,
  storedAliasIsValid,
  storedChildIsValid,
  storedFactIsValid,
  storedParentIsValid,
  storedTombstoneIsValid,
  type AgentStatusStoreState
} from './agent-status-store-state'
import { AgentStatusStoreDraftTable } from './agent-status-store-table'
import { serializeAgentStatusSubject } from './agent-status-subject'

/** Present keys of one draft that an index (or this mutation) places under a query, in map order. */
function draftQuery<V>(
  indexes: AgentStatusStoreIndexes,
  name: 'children' | 'aliases' | 'facts',
  draft: AgentStatusStoreDraftTable<V>,
  indexed: Iterable<string>,
  matches: (record: V) => boolean
): string[] {
  const inPlace = new Set<string>()
  for (const key of indexed) {
    if (!draft.removedKeys.has(key)) {
      inPlace.add(key)
    }
  }
  for (const { key, next } of draft.touched()) {
    if (next !== undefined && !draft.appendedKeys.has(key)) {
      inPlace.add(key)
    }
  }
  const present = (key: string) => {
    const record = draft.get(key)
    return record !== undefined && matches(record)
  }
  const keys = inMapOrder(indexes, name, [...inPlace].filter(present))
  for (const key of draft.appendedKeys) {
    if (present(key)) {
      keys.push(key)
    }
  }
  return keys
}

function draftTables(
  state: AgentStatusStoreState,
  indexes: AgentStatusStoreIndexes,
  revision: number
): { drafts: AgentStatusStoreDrafts; tables: AgentStatusStoreMutationTables } {
  const drafts: AgentStatusStoreDrafts = {
    parents: new AgentStatusStoreDraftTable(state.parents),
    children: new AgentStatusStoreDraftTable(state.children),
    aliases: new AgentStatusStoreDraftTable(state.aliases),
    facts: new AgentStatusStoreDraftTable(state.facts),
    tombstones: new AgentStatusStoreDraftTable(state.tombstones)
  }
  const tables: AgentStatusStoreMutationTables = {
    revision,
    ...drafts,
    childrenOf: (parentKey) =>
      draftQuery(
        indexes,
        'children',
        drafts.children,
        indexes.childrenByParent.get(parentKey) ?? [],
        (child) => serializeAgentStatusSubject(child.parent) === parentKey
      ),
    factsOf: (parentKey) =>
      draftQuery(
        indexes,
        'facts',
        drafts.facts,
        indexes.factsByParent.get(parentKey) ?? [],
        (fact) => serializeAgentStatusSubject(fact.subject) === parentKey
      ),
    aliasesOfChildren: (childWorkIds) =>
      draftQuery(
        indexes,
        'aliases',
        drafts.aliases,
        [...childWorkIds].flatMap((id) => [...(indexes.aliasesByChild.get(id) ?? [])]),
        (alias) => childWorkIds.has(alias.childWorkId)
      )
  }
  return { drafts, tables }
}

function touchedAreValid(
  drafts: AgentStatusStoreDrafts,
  tables: AgentStatusStoreMutationTables
): boolean {
  const removedParents: string[] = []
  for (const { key, next } of drafts.parents.touched()) {
    if (!next) {
      removedParents.push(key)
    } else if (!storedParentIsValid(tables, key, next)) {
      return false
    }
  }
  // A parent's removal must have taken its children and facts with it.
  if (
    removedParents.some(
      (key) => tables.childrenOf(key).length > 0 || tables.factsOf(key).length > 0
    )
  ) {
    return false
  }
  const touchedChildren = new Set<string>()
  for (const { key, next } of drafts.children.touched()) {
    touchedChildren.add(key)
    if (next && !storedChildIsValid(tables, key, next)) {
      return false
    }
  }
  // An alias is valid against its child, so a touched child re-checks every alias naming it.
  const aliases = new Set(tables.aliasesOfChildren(touchedChildren))
  for (const { key, next } of drafts.aliases.touched()) {
    if (next) {
      aliases.add(key)
    }
  }
  for (const key of aliases) {
    const alias = drafts.aliases.get(key)
    if (alias && !storedAliasIsValid(tables, key, alias)) {
      return false
    }
  }
  for (const { key, next } of drafts.facts.touched()) {
    if (next && !storedFactIsValid(tables, key, next)) {
      return false
    }
  }
  for (const { next } of drafts.tombstones.touched()) {
    if (next && !storedTombstoneIsValid(tables, next)) {
      return false
    }
  }
  return true
}

function fitsByteBudget(
  epoch: string,
  revision: number,
  drafts: AgentStatusStoreDrafts,
  recordBytes: Record<keyof AgentStatusStoreDrafts, number>
): boolean {
  let bytes = agentStatusStoreHeaderBytes(epoch, revision)
  for (const name of ['parents', 'children', 'aliases', 'facts', 'tombstones'] as const) {
    bytes += Math.max(0, drafts[name].size - 1) + recordBytes[name]
  }
  return bytes <= AGENT_STATUS_STORE_LIMITS.serializedBytes
}

/** Apply one mutation to the committed store in place; false (and nothing changed) on refusal. */
export function commitAgentStatusStoreMutation(
  state: AgentStatusStoreState,
  indexes: AgentStatusStoreIndexes,
  mutation: AgentStatusStoreMutation,
  revision: number
): boolean {
  const { drafts, tables } = draftTables(state, indexes, revision)
  if (
    !applyAgentStatusStoreMutationSteps(tables, mutation, revision) ||
    !agentStatusStoreSizesFit(drafts) ||
    !touchedAreValid(drafts, tables)
  ) {
    return false
  }
  const recordBytes = draftedRecordBytes(indexes, drafts)
  if (!fitsByteBudget(state.epoch, revision, drafts, recordBytes)) {
    return false
  }
  commitAgentStatusStoreIndexes(indexes, drafts, recordBytes)
  drafts.parents.commitInto(state.parents)
  drafts.children.commitInto(state.children)
  drafts.aliases.commitInto(state.aliases)
  drafts.facts.commitInto(state.facts)
  drafts.tombstones.commitInto(state.tombstones)
  state.revision = revision
  return true
}
