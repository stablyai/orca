import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import { deserializeAgentChildWorkBindingKey } from './agent-status-child-work-binding'
import {
  deepFreezeAgentStatusStoreValue,
  type AgentStatusStoreState
} from './agent-status-store-state'

/** Retired bindings fence delayed observations even after their child/history is removed. */
export function resolveAgentStatusChildBindings(
  state: AgentStatusStoreState,
  aliases: AgentChildWorkAliasInput[]
): AgentChildWorkAliasRecord[] {
  const keys = new Set(aliases.map(serializeAgentChildWorkAliasKey))
  const matches: AgentChildWorkAliasRecord[] = []
  for (const alias of state.aliases.values()) {
    if (keys.has(serializeAgentChildWorkAliasKey(alias))) {
      matches.push(alias)
    }
  }
  for (const tombstone of state.tombstones.values()) {
    if (tombstone.entity !== 'alias' || state.aliases.has(tombstone.key)) {
      continue
    }
    const alias = deserializeAgentChildWorkBindingKey(tombstone.key)
    if (alias && keys.has(serializeAgentChildWorkAliasKey(alias))) {
      matches.push(deepFreezeAgentStatusStoreValue({ ...alias, revision: tombstone.revision }))
    }
  }
  return matches
}
