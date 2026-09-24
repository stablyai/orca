import { agentChildWorkBelongsTo, type AgentChildWorkRecord } from './agent-status-child-work'
import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasIdentity,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import { parseAgentChildWorkRecord } from './agent-status-child-work-codec'
import { resolveAgentStatusChildBindings } from './agent-status-store-child-queries'
import type { AgentStatusStoreSnapshot } from './agent-status-store-contract'
import {
  isAgentStatusStoreEpoch,
  parseAgentStatusStoreMutation,
  parseAgentStatusStoreSnapshot
} from './agent-status-store-codec'
import { applyAgentStatusStoreMutation } from './agent-status-store-mutation'
import type { AgentStatusRunAliasIndex } from './agent-status-run-alias-index'
import {
  parseAgentStatusParentRecord,
  type AgentStatusParentRecord
} from './agent-status-store-parent'
import {
  agentStatusStoreStateFromSnapshot,
  createEmptyAgentStatusStoreState,
  deepFreezeAgentStatusStoreValue,
  snapshotFromAgentStatusStoreState
} from './agent-status-store-state'
import { deriveAgentStatusStoreRunAliasIndex } from './agent-status-store-run-index'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusSubject
} from './agent-status-subject'
import {
  parseAgentStatusTransportEnvelope,
  type AgentStatusMutationEnvelope
} from './agent-status-transport-envelope'

export type AgentStatusStoreMode = 'authority' | 'replica'

export type AgentStatusStore = {
  getParent(subject: AgentStatusSubject): AgentStatusParentRecord | null
  getChildren(subject: AgentStatusSubject): AgentChildWorkRecord[]
  getChild(childWorkId: string): AgentChildWorkRecord | null
  getAlias(identity: AgentChildWorkAliasIdentity): AgentChildWorkAliasRecord | null
  getAliasesForChild(childWorkId: string): AgentChildWorkAliasRecord[]
  getRunAliasIndex(): AgentStatusRunAliasIndex
  resolveChildAliases(aliases: AgentChildWorkAliasInput[]): AgentChildWorkAliasRecord[]
  getSnapshot(): AgentStatusStoreSnapshot
  applyMutation(mutation: unknown): AgentStatusMutationEnvelope | null
  applySnapshot(snapshot: unknown): boolean
  applyTransportEnvelope(envelope: unknown): boolean
}

export type CreateAgentStatusStoreOptions = {
  epoch: string
  mode: AgentStatusStoreMode
}

export function createAgentStatusStore(options: CreateAgentStatusStoreOptions): AgentStatusStore {
  if (!isAgentStatusStoreEpoch(options.epoch)) {
    throw new Error('Invalid agent status store epoch')
  }
  let state = createEmptyAgentStatusStoreState(options.epoch)
  let snapshotApplied = options.mode === 'authority'

  const store: AgentStatusStore = {
    resolveChildAliases(aliases) {
      return resolveAgentStatusChildBindings(state, aliases)
    },
    getParent(subject) {
      const parsed = parseAgentStatusSubject(subject)
      if (!parsed) {
        return null
      }
      const record = state.parents.get(serializeAgentStatusSubject(parsed))
      return record ? deepFreezeAgentStatusStoreValue(parseAgentStatusParentRecord(record)) : null
    },
    getChildren(subject) {
      const parsed = parseAgentStatusSubject(subject)
      if (!parsed) {
        return []
      }
      const children = [...state.children.values()]
        .filter((child) => agentChildWorkBelongsTo(child, parsed))
        .map((child) => parseAgentChildWorkRecord(child))
        .filter((child): child is AgentChildWorkRecord => child !== null)
      return deepFreezeAgentStatusStoreValue(children)
    },
    getChild(childWorkId) {
      return state.children.get(childWorkId) ?? null
    },
    getAlias(identity) {
      return state.aliases.get(serializeAgentChildWorkAliasKey(identity)) ?? null
    },
    getAliasesForChild(childWorkId) {
      return deepFreezeAgentStatusStoreValue(
        [...state.aliases.values()].filter((alias) => alias.childWorkId === childWorkId)
      )
    },
    getRunAliasIndex() {
      return deriveAgentStatusStoreRunAliasIndex(state.parents.values())
    },
    getSnapshot() {
      return snapshotFromAgentStatusStoreState(state)
    },
    applyMutation(value) {
      if (options.mode !== 'authority') {
        return null
      }
      const mutation = parseAgentStatusStoreMutation(value)
      if (!mutation || state.revision === Number.MAX_SAFE_INTEGER) {
        return null
      }
      const previousRevision = state.revision
      const next = applyAgentStatusStoreMutation(state, mutation, previousRevision + 1)
      if (!next) {
        return null
      }
      state = next
      return deepFreezeAgentStatusStoreValue({
        type: 'mutation',
        epoch: state.epoch,
        previousRevision,
        revision: state.revision,
        mutation
      })
    },
    applySnapshot(value) {
      const snapshot = parseAgentStatusStoreSnapshot(value)
      if (!snapshot) {
        return false
      }
      if (options.mode === 'authority') {
        if (state.revision !== 0) {
          return false
        }
        const restored = agentStatusStoreStateFromSnapshot(snapshot, options.epoch)
        if (!restored) {
          return false
        }
        state = restored
        snapshotApplied = true
        return true
      }
      if (
        snapshotApplied &&
        snapshot.epoch === state.epoch &&
        snapshot.revision <= state.revision
      ) {
        return false
      }
      const mirrored = agentStatusStoreStateFromSnapshot(snapshot, snapshot.epoch)
      if (!mirrored) {
        return false
      }
      state = mirrored
      snapshotApplied = true
      return true
    },
    applyTransportEnvelope(value) {
      if (options.mode !== 'replica') {
        return false
      }
      const envelope = parseAgentStatusTransportEnvelope(value)
      if (!envelope) {
        return false
      }
      if (envelope.type === 'snapshot') {
        return store.applySnapshot(envelope.snapshot)
      }
      if (
        !snapshotApplied ||
        envelope.epoch !== state.epoch ||
        envelope.previousRevision !== state.revision ||
        envelope.revision !== state.revision + 1
      ) {
        return false
      }
      const next = applyAgentStatusStoreMutation(state, envelope.mutation, envelope.revision)
      if (!next) {
        return false
      }
      state = next
      return true
    }
  }
  return store
}
