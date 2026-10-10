import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import { inMapOrder, type AgentStatusStoreIndexes } from './agent-status-store-indexes'
import { storedRetiredAlias } from './agent-status-store-record-keys'
import {
  deepFreezeAgentStatusStoreValue,
  type AgentStatusStoreState
} from './agent-status-store-state'

/** Retired bindings fence delayed observations even after their child/history is removed. */
export function resolveAgentStatusChildBindings(
  state: AgentStatusStoreState,
  indexes: AgentStatusStoreIndexes,
  aliases: AgentChildWorkAliasInput[]
): AgentChildWorkAliasRecord[] {
  const identities = new Set(aliases.map(serializeAgentChildWorkAliasKey))
  const bound = new Set<string>()
  const retired = new Set<string>()
  for (const identity of identities) {
    for (const key of indexes.aliasesByIdentity.get(identity) ?? []) {
      bound.add(key)
    }
    for (const key of indexes.retiredAliasesByIdentity.get(identity) ?? []) {
      retired.add(key)
    }
  }
  const matches: AgentChildWorkAliasRecord[] = []
  for (const key of inMapOrder(indexes, 'aliases', bound)) {
    const alias = state.aliases.get(key)
    if (alias) {
      matches.push(alias)
    }
  }
  for (const key of inMapOrder(indexes, 'tombstones', retired)) {
    const tombstone = state.tombstones.get(key)
    const binding = tombstone ? storedRetiredAlias(tombstone) : null
    if (tombstone && binding && !state.aliases.has(tombstone.key)) {
      matches.push(
        deepFreezeAgentStatusStoreValue({ ...binding.alias, revision: tombstone.revision })
      )
    }
  }
  return matches
}

/** A parent's children in map order; stored records were parsed and frozen when written. */
export function agentStatusStoreChildrenOf(
  state: AgentStatusStoreState,
  indexes: AgentStatusStoreIndexes,
  parentKey: string
): AgentChildWorkRecord[] {
  const children: AgentChildWorkRecord[] = []
  for (const id of inMapOrder(indexes, 'children', indexes.childrenByParent.get(parentKey))) {
    const child = state.children.get(id)
    if (child) {
      children.push(child)
    }
  }
  return children
}

export function agentStatusStoreAliasesOf(
  state: AgentStatusStoreState,
  indexes: AgentStatusStoreIndexes,
  childWorkId: string
): AgentChildWorkAliasRecord[] {
  const aliases: AgentChildWorkAliasRecord[] = []
  for (const key of inMapOrder(indexes, 'aliases', indexes.aliasesByChild.get(childWorkId))) {
    const alias = state.aliases.get(key)
    if (alias) {
      aliases.push(alias)
    }
  }
  return aliases
}
