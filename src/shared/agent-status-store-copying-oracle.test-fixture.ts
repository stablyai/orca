// The store as it was before mutations landed in place: every mutation copies every map, applies
// its steps to the copies, and re-validates the whole result; every read scans. Tests hold the
// real store to this, decision for decision and snapshot for snapshot.

import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import { deserializeAgentChildWorkBindingKey } from './agent-status-child-work-binding'
import { agentChildWorkBelongsTo, type AgentChildWorkRecord } from './agent-status-child-work'
import { parseAgentStatusStoreMutation } from './agent-status-store-codec'
import {
  AGENT_STATUS_STORE_SNAPSHOT_VERSION,
  type AgentStatusStoreSnapshot
} from './agent-status-store-contract'
import { applyAgentStatusStoreMutationSteps } from './agent-status-store-mutation'
import {
  cloneAgentStatusStoreState,
  createEmptyAgentStatusStoreState,
  deepFreezeAgentStatusStoreValue,
  validateAgentStatusStoreState,
  type AgentStatusStoreState
} from './agent-status-store-state'
import { serializeAgentStatusSubject, type AgentStatusSubject } from './agent-status-subject'

function keysWhere<V>(map: Map<string, V>, matches: (record: V) => boolean): string[] {
  return [...map].flatMap(([key, record]) => (matches(record) ? [key] : []))
}

function applyByCopy(current: AgentStatusStoreState, value: unknown): AgentStatusStoreState | null {
  const mutation = parseAgentStatusStoreMutation(value)
  if (!mutation) {
    return null
  }
  const revision = current.revision + 1
  const next = cloneAgentStatusStoreState(current)
  next.revision = revision
  const applied = applyAgentStatusStoreMutationSteps(
    {
      revision,
      parents: next.parents,
      children: next.children,
      aliases: next.aliases,
      facts: next.facts,
      tombstones: next.tombstones,
      childrenOf: (parentKey) =>
        keysWhere(
          next.children,
          (child) => serializeAgentStatusSubject(child.parent) === parentKey
        ),
      factsOf: (parentKey) =>
        keysWhere(next.facts, (fact) => serializeAgentStatusSubject(fact.subject) === parentKey),
      aliasesOfChildren: (ids) => keysWhere(next.aliases, (alias) => ids.has(alias.childWorkId))
    },
    mutation,
    revision
  )
  return applied && validateAgentStatusStoreState(next) ? next : null
}

export type CopyingAgentStatusStoreOracle = {
  applyMutation(mutation: unknown): boolean
  getSnapshot(): AgentStatusStoreSnapshot
  /** The oracle's own maps, for fixture coverage and diagnostics. */
  state(): AgentStatusStoreState
  getChildren(subject: AgentStatusSubject): AgentChildWorkRecord[]
  getAliasesForChild(childWorkId: string): AgentChildWorkAliasRecord[]
  resolveChildAliases(aliases: AgentChildWorkAliasInput[]): AgentChildWorkAliasRecord[]
}

export function createCopyingAgentStatusStoreOracle(epoch: string): CopyingAgentStatusStoreOracle {
  let current = createEmptyAgentStatusStoreState(epoch)
  return {
    applyMutation(mutation) {
      const next = applyByCopy(current, mutation)
      if (next) {
        current = next
      }
      return next !== null
    },
    // Project the validated maps independently of the production snapshot parser.
    getSnapshot: () =>
      deepFreezeAgentStatusStoreValue({
        version: AGENT_STATUS_STORE_SNAPSHOT_VERSION,
        epoch: current.epoch,
        revision: current.revision,
        parents: [...current.parents.values()],
        children: [...current.children.values()],
        aliases: [...current.aliases.values()],
        facts: [...current.facts.values()],
        tombstones: [...current.tombstones.values()]
      }),
    state: () => current,
    getChildren: (subject) =>
      [...current.children.values()].filter((child) => agentChildWorkBelongsTo(child, subject)),
    getAliasesForChild: (childWorkId) =>
      [...current.aliases.values()].filter((alias) => alias.childWorkId === childWorkId),
    resolveChildAliases(aliases) {
      if (aliases.length === 0) {
        return []
      }
      const keys = new Set(aliases.map(serializeAgentChildWorkAliasKey))
      const matches: AgentChildWorkAliasRecord[] = []
      for (const alias of current.aliases.values()) {
        if (keys.has(serializeAgentChildWorkAliasKey(alias))) {
          matches.push(alias)
        }
      }
      for (const tombstone of current.tombstones.values()) {
        if (tombstone.entity !== 'alias' || current.aliases.has(tombstone.key)) {
          continue
        }
        const alias = deserializeAgentChildWorkBindingKey(tombstone.key)
        if (alias && keys.has(serializeAgentChildWorkAliasKey(alias))) {
          matches.push({ ...alias, revision: tombstone.revision })
        }
      }
      return matches
    }
  }
}
