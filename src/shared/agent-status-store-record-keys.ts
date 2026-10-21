// Keys the store derives from its own records. A stored record is frozen, so a key re-derived for
// every edge that touches the record (an alias re-validated with its child, a retired binding read
// on every lookup) is computed once per record.

import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  deserializeAgentChildWorkBindingKey,
  serializeAgentChildWorkBindingKey
} from './agent-status-child-work-binding'
import type { AgentStatusTombstoneRecord } from './agent-status-store-contract'
import { deserializeAgentStatusFactKey } from './agent-status-store-fact-codec'
import { deserializeAgentStatusSubject } from './agent-status-subject'

function memoized<R extends object, V extends {} | null>(
  cache: WeakMap<R, V>,
  record: R,
  derive: (record: R) => V
): V {
  const cached = cache.get(record)
  if (cached !== undefined) {
    return cached
  }
  const value = derive(record)
  if (Object.isFrozen(record)) {
    cache.set(record, value)
  }
  return value
}

const bindingKeys = new WeakMap<AgentChildWorkAliasRecord, string>()
type RetiredAlias = { alias: AgentChildWorkAliasInput; key: string }
const retiredAliases = new WeakMap<AgentStatusTombstoneRecord, RetiredAlias | null>()

export function storedBindingKey(alias: AgentChildWorkAliasRecord): string {
  return memoized(bindingKeys, alias, serializeAgentChildWorkBindingKey)
}

/** The binding a retired alias's tombstone names, with its alias key; null for any other tombstone. */
export function storedRetiredAlias(tombstone: AgentStatusTombstoneRecord): RetiredAlias | null {
  return memoized(retiredAliases, tombstone, (record) => {
    const alias = record.entity === 'alias' ? deserializeAgentChildWorkBindingKey(record.key) : null
    return alias ? { alias, key: serializeAgentChildWorkAliasKey(alias) } : null
  })
}

export function tombstoneKeyIsValid(tombstone: AgentStatusTombstoneRecord): boolean {
  switch (tombstone.entity) {
    case 'parent':
      return deserializeAgentStatusSubject(tombstone.key) !== null
    case 'alias':
      return deserializeAgentChildWorkBindingKey(tombstone.key) !== null
    case 'fact':
      return deserializeAgentStatusFactKey(tombstone.key) !== null
    case 'child':
      return true
  }
}
