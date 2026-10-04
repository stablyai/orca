// Lookups the store keeps beside its maps, so a read or a mutation costs what it touches rather
// than the whole store. Every index is derived from the committed maps and moved only at commit.

import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import { agentStatusStoreRecordBytes } from './agent-status-store-byte-budget'
import type {
  AgentStatusFactRecord,
  AgentStatusTombstoneRecord
} from './agent-status-store-contract'
import type { AgentStatusParentRecord } from './agent-status-store-parent'
import { storedRetiredAlias } from './agent-status-store-record-keys'
import type { AgentStatusStoreState } from './agent-status-store-state'
import type { AgentStatusStoreDraftTable } from './agent-status-store-table'
import { serializeAgentStatusSubject } from './agent-status-subject'

const TABLE_NAMES = ['parents', 'children', 'aliases', 'facts', 'tombstones'] as const
type TableName = (typeof TABLE_NAMES)[number]
type OrderedTableName = Exclude<TableName, 'parents'>

export type AgentStatusStoreIndexes = {
  /** Serialized bytes of every record per table, for the snapshot budget. */
  recordBytes: Record<TableName, number>
  childrenByParent: Map<string, Set<string>>
  factsByParent: Map<string, Set<string>>
  aliasesByChild: Map<string, Set<string>>
  aliasesByIdentity: Map<string, Set<string>>
  /** Alias identity → tombstone map keys of its retired bindings. */
  retiredAliasesByIdentity: Map<string, Set<string>>
  /** Each key's place in its map, so an index read returns records in map order. */
  order: Record<OrderedTableName, Map<string, number>>
  nextOrder: number
}

export type AgentStatusStoreDrafts = {
  parents: AgentStatusStoreDraftTable<AgentStatusParentRecord>
  children: AgentStatusStoreDraftTable<AgentChildWorkRecord>
  aliases: AgentStatusStoreDraftTable<AgentChildWorkAliasRecord>
  facts: AgentStatusStoreDraftTable<AgentStatusFactRecord>
  tombstones: AgentStatusStoreDraftTable<AgentStatusTombstoneRecord>
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key)
  if (values) {
    values.add(value)
  } else {
    index.set(key, new Set([value]))
  }
}

function removeFrom(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key)
  if (values?.delete(value) && values.size === 0) {
    index.delete(key)
  }
}

function indexChild(
  indexes: AgentStatusStoreIndexes,
  id: string,
  child: AgentChildWorkRecord,
  add: boolean
) {
  const parentKey = serializeAgentStatusSubject(child.parent)
  if (add) {
    addTo(indexes.childrenByParent, parentKey, id)
  } else {
    removeFrom(indexes.childrenByParent, parentKey, id)
  }
}

function indexAlias(
  indexes: AgentStatusStoreIndexes,
  key: string,
  alias: AgentChildWorkAliasRecord,
  add: boolean
) {
  const update = add ? addTo : removeFrom
  update(indexes.aliasesByChild, alias.childWorkId, key)
  update(indexes.aliasesByIdentity, serializeAgentChildWorkAliasKey(alias), key)
}

function indexFact(
  indexes: AgentStatusStoreIndexes,
  key: string,
  fact: AgentStatusFactRecord,
  add: boolean
) {
  const update = add ? addTo : removeFrom
  update(indexes.factsByParent, serializeAgentStatusSubject(fact.subject), key)
}

function indexTombstone(
  indexes: AgentStatusStoreIndexes,
  key: string,
  tombstone: AgentStatusTombstoneRecord,
  add: boolean
) {
  const retired = storedRetiredAlias(tombstone)
  if (retired) {
    const update = add ? addTo : removeFrom
    update(indexes.retiredAliasesByIdentity, retired.key, key)
  }
}

export function indexAgentStatusStoreState(state: AgentStatusStoreState): AgentStatusStoreIndexes {
  const indexes: AgentStatusStoreIndexes = {
    recordBytes: { parents: 0, children: 0, aliases: 0, facts: 0, tombstones: 0 },
    childrenByParent: new Map(),
    factsByParent: new Map(),
    aliasesByChild: new Map(),
    aliasesByIdentity: new Map(),
    retiredAliasesByIdentity: new Map(),
    order: { children: new Map(), aliases: new Map(), facts: new Map(), tombstones: new Map() },
    nextOrder: 0
  }
  for (const parent of state.parents.values()) {
    indexes.recordBytes.parents += agentStatusStoreRecordBytes(parent)
  }
  for (const [id, child] of state.children) {
    indexes.recordBytes.children += agentStatusStoreRecordBytes(child)
    indexes.order.children.set(id, indexes.nextOrder++)
    indexChild(indexes, id, child, true)
  }
  for (const [key, alias] of state.aliases) {
    indexes.recordBytes.aliases += agentStatusStoreRecordBytes(alias)
    indexes.order.aliases.set(key, indexes.nextOrder++)
    indexAlias(indexes, key, alias, true)
  }
  for (const [key, fact] of state.facts) {
    indexes.recordBytes.facts += agentStatusStoreRecordBytes(fact)
    indexes.order.facts.set(key, indexes.nextOrder++)
    indexFact(indexes, key, fact, true)
  }
  for (const [key, tombstone] of state.tombstones) {
    indexes.recordBytes.tombstones += agentStatusStoreRecordBytes(tombstone)
    indexes.order.tombstones.set(key, indexes.nextOrder++)
    indexTombstone(indexes, key, tombstone, true)
  }
  return indexes
}

/** Record bytes per table once the drafts land. */
export function draftedRecordBytes(
  indexes: AgentStatusStoreIndexes,
  drafts: AgentStatusStoreDrafts
): Record<TableName, number> {
  const bytes = { ...indexes.recordBytes }
  for (const name of TABLE_NAMES) {
    for (const { previous, next } of drafts[name].touched()) {
      bytes[name] +=
        (next ? agentStatusStoreRecordBytes(next) : 0) -
        (previous ? agentStatusStoreRecordBytes(previous) : 0)
    }
  }
  return bytes
}

function moveIndex<V>(
  draft: AgentStatusStoreDraftTable<V>,
  index: (key: string, record: V, add: boolean) => void
): void {
  for (const { key, previous, next } of draft.touched()) {
    if (previous) {
      index(key, previous, false)
    }
    if (next) {
      index(key, next, true)
    }
  }
}

function moveOrder<V>(
  indexes: AgentStatusStoreIndexes,
  name: OrderedTableName,
  draft: AgentStatusStoreDraftTable<V>
): void {
  const order = indexes.order[name]
  for (const key of draft.removedKeys) {
    order.delete(key)
  }
  for (const key of draft.appendedKeys) {
    order.set(key, indexes.nextOrder++)
  }
}

/** Move every index by what the drafts changed; call before the drafts land in the maps. */
export function commitAgentStatusStoreIndexes(
  indexes: AgentStatusStoreIndexes,
  drafts: AgentStatusStoreDrafts,
  recordBytes: Record<TableName, number>
): void {
  indexes.recordBytes = recordBytes
  moveIndex(drafts.children, (key, child, add) => indexChild(indexes, key, child, add))
  moveIndex(drafts.aliases, (key, alias, add) => indexAlias(indexes, key, alias, add))
  moveIndex(drafts.facts, (key, fact, add) => indexFact(indexes, key, fact, add))
  moveIndex(drafts.tombstones, (key, tombstone, add) =>
    indexTombstone(indexes, key, tombstone, add)
  )
  moveOrder(indexes, 'children', drafts.children)
  moveOrder(indexes, 'aliases', drafts.aliases)
  moveOrder(indexes, 'facts', drafts.facts)
  moveOrder(indexes, 'tombstones', drafts.tombstones)
}

/** Committed keys an index names, in map order. */
export function inMapOrder(
  indexes: AgentStatusStoreIndexes,
  name: OrderedTableName,
  keys: Iterable<string> | undefined
): string[] {
  if (!keys) {
    return []
  }
  const order = indexes.order[name]
  return [...keys].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
}
