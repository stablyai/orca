import type { AgentChildWorkRecord } from './agent-status-child-work'
import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasIdentity,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  agentStatusStoreAliasesOf,
  agentStatusStoreChildrenOf,
  resolveAgentStatusChildBindings
} from './agent-status-store-child-queries'
import { commitAgentStatusStoreMutation } from './agent-status-store-commit'
import type { AgentStatusStoreSnapshot } from './agent-status-store-contract'
import {
  isAgentStatusStoreEpoch,
  parseAgentStatusStoreMutation,
  parseAgentStatusStoreSnapshot
} from './agent-status-store-codec'
import { indexAgentStatusStoreState } from './agent-status-store-indexes'
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
  /** Every parent in insertion order, without materializing the child records a snapshot holds. */
  getParents(): AgentStatusParentRecord[]
  getRevision(): { epoch: string; revision: number }
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
  let indexes = indexAgentStatusStoreState(state)
  let snapshotApplied = options.mode === 'authority'
  const restore = (restored: typeof state) => {
    state = restored
    indexes = indexAgentStatusStoreState(restored)
    snapshotApplied = true
  }

  const store: AgentStatusStore = {
    resolveChildAliases(aliases) {
      return resolveAgentStatusChildBindings(state, indexes, aliases)
    },
    getParent(subject) {
      const parsed = parseAgentStatusSubject(subject)
      if (!parsed) {
        return null
      }
      const record = state.parents.get(serializeAgentStatusSubject(parsed))
      return record ? deepFreezeAgentStatusStoreValue(parseAgentStatusParentRecord(record)) : null
    },
    getParents() {
      return [...state.parents.values()]
    },
    getRevision() {
      return { epoch: state.epoch, revision: state.revision }
    },
    getChildren(subject) {
      const parsed = parseAgentStatusSubject(subject)
      if (!parsed) {
        return []
      }
      return deepFreezeAgentStatusStoreValue(
        agentStatusStoreChildrenOf(state, indexes, serializeAgentStatusSubject(parsed))
      )
    },
    getChild(childWorkId) {
      return state.children.get(childWorkId) ?? null
    },
    getAlias(identity) {
      return state.aliases.get(serializeAgentChildWorkAliasKey(identity)) ?? null
    },
    getAliasesForChild(childWorkId) {
      return deepFreezeAgentStatusStoreValue(agentStatusStoreAliasesOf(state, indexes, childWorkId))
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
      if (!commitAgentStatusStoreMutation(state, indexes, mutation, previousRevision + 1)) {
        return null
      }
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
        restore(restored)
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
      restore(mirrored)
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
      return commitAgentStatusStoreMutation(state, indexes, envelope.mutation, envelope.revision)
    }
  }
  return store
}
