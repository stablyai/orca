import type { RemovalNoticeRoot } from './slices/worktrees/teardown/removed-workspace-unsaved-files'
import type { PreparedPurgeOwnership } from './slices/worktrees/teardown/worktree-purge-preparation'
import type { HostWorkingClientBoundary } from '../runtime/web-session-tabs-sync/state'
import { createAgentPaneAuthority } from './slices/agent-pane-authority'
import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId
} from '../../../shared/agent-status-observation'
import {
  createAgentStatusReadViews,
  createAgentStatusTransaction,
  writeAgentStatusFold,
  type AgentStatusTransaction,
  type StatusStage
} from './agent-status-fold'
import { bindTerminalFactGetters } from './terminal-fact-publication'
import type { StateCreator, StoreApi } from 'zustand'
import { shallow } from 'zustand/vanilla/shallow'
import type { AppState } from './types'
import { installStructuredReadRetirement } from '../components/native-chat/structured-agent-session-read-owner-registry'
import { removedStructuredReaders } from './structured-tab-read-retirement'
import type { AgentStatusEntry } from './slices/agent-status-contract'
import type { StoreSetArgs } from './react-commit-cascade-write-probe'
import {
  createAgentStatusObservers,
  reportAgentStatusObserverError,
  type AgentStatusSnapshot
} from './agent-status-observers'

export type { AgentStatusTransaction } from './agent-status-fold'
export type AgentStatusOwner = ReturnType<typeof createAgentStatusOwner>
const owners = new WeakMap<object, AgentStatusOwner>()
const actionOwners = new WeakMap<AppState['transferAgentPaneAuthority'], AgentStatusOwner>()
export function findAgentStatusOwnerByReader(
  getState: () => unknown
): AgentStatusOwner | undefined {
  return owners.get(getState)
}

export function findAgentStatusOwner(
  state: Partial<Pick<AppState, 'transferAgentPaneAuthority'>>
): AgentStatusOwner | undefined {
  const transfer = state.transferAgentPaneAuthority
  return transfer ? actionOwners.get(transfer) : undefined
}

export function getAgentStatusOwner(store: Pick<StoreApi<AppState>, 'getState'>): AgentStatusOwner {
  const owner = owners.get(store.getState)
  if (!owner) {
    throw new Error('Store has no agent-status owner')
  }
  return owner
}

export function afterStoreAcceptance(store: { getState: () => unknown }, effect: () => void): void {
  const owner = owners.get(store.getState)
  return owner ? owner.afterCommit(effect) : effect()
}

function createAgentStatusOwner(rawSet: StoreApi<AppState>['setState'], get: () => AppState) {
  const observers = createAgentStatusObservers(get)
  let mirrorBoundaries = new Map<string, HostWorkingClientBoundary>()
  let authority = createAgentPaneAuthority()
  let observations = new AgentStatusObservationSequencer(createAgentStatusAuthorityId('renderer'))
  let live: AgentStatusSnapshot = Object.setPrototypeOf({}, null)
  let stage: StatusStage | null = null
  let pending: { app: AppState; accept: () => void } | null = null
  let appDepth = 0
  let coordinatedDepth = 0
  let appFrame: { live: AgentStatusSnapshot } | null = null
  const joined = createAgentStatusReadViews()
  const afterCommit = (effect: () => void): void => {
    if (stage) {
      stage.effects.push(effect)
    } else {
      effect()
    }
  }
  const transaction = createAgentStatusTransaction(
    () => stage,
    () => joined(get(), live),
    afterCommit
  )
  const write = (...args: StoreSetArgs<AppState>): void => {
    if (stage) {
      writeAgentStatusFold(stage, ...args)
      return
    }
    const previousFrame = appFrame
    appDepth++
    try {
      const resolved =
        args[1] === true
          ? ([typeof args[0] === 'function' ? args[0](get()) : args[0], true] as const)
          : ([typeof args[0] === 'function' ? args[0](get()) : args[0], args[1]] as const)
      appFrame = { live }
      const requested = resolved[0]
      const previous = get()
      if (
        requested.unifiedTabsByWorktree &&
        requested.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree
      ) {
        const next = Object.assign({}, previous, requested)
        if (removedStructuredReaders(previous, next).length > 0) {
          // Close intent can be refused; only the accepted tab removal ends its reader lifetime.
          owner.transact(() => write(next, true))
          return
        }
      }
      if (resolved[1] === true) {
        rawSet(...resolved)
      } else {
        rawSet(...resolved)
      }
    } finally {
      appFrame = previousFrame
      appDepth--
      if (appDepth === 0) {
        observers.drain()
      }
    }
  }
  const owner = {
    purgedLaunches: () => stage?.purgedLaunches,
    purgeNotice(create: () => RemovalNoticeRoot): RemovalNoticeRoot {
      return stage ? (stage.notice ??= create()) : create()
    },
    preparePurgeOwnership(prepared: PreparedPurgeOwnership): void {
      if (stage) {
        stage.purge.push(prepared)
        stage.effects.push(...prepared.effects)
      } else {
        prepared.install()
        for (const effect of prepared.effects) {
          effect()
        }
      }
    },
    isPreparing: () => stage !== null,
    mirrorBoundaries: () =>
      stage ? (stage.mirrorBoundaries ??= new Map(mirrorBoundaries)) : mirrorBoundaries,
    authority: () => (stage ? (stage.authority ??= authority.fork()) : authority),
    observations: () => (stage ? (stage.observations ??= observations.fork()) : observations),
    subscribeEntry: observers.subscribeEntry,
    subscribeTab: observers.subscribeTab,
    subscribeAggregate: observers.subscribeAggregate,
    subscribeTransitions: observers.subscribeTransitions,
    getEntry: (paneKey: string): AgentStatusEntry | undefined => live[paneKey],
    getSnapshot: () => live,
    getState: () => joined(get(), live),
    getTransactionState: transaction.getState,
    getAppRevision: () => stage?.appRevision ?? 0,
    getAppState: () => stage?.app ?? get(),
    afterCommit,
    write,
    isCoordinated: () => coordinatedDepth > 0,
    receipt(app: AppState, previous: AppState): void {
      const install = pending
      pending = null
      if (install?.app === app) {
        install.accept()
      } else {
        const previousLive = appFrame?.live ?? live
        const nextLive = live
        observers.prepare(
          () => joined(previous, previousLive),
          () => joined(app, nextLive),
          new Set(),
          []
        )()
      }
    },
    transact<Result>(operation: (transaction: AgentStatusTransaction) => Result): Result {
      if (stage) {
        return operation(transaction)
      }
      const previous = get()
      const previousLive = live
      const prepared: StatusStage = {
        accepted: false,
        notice: null,
        purge: [],
        purgedLaunches: new Set(),
        mirrorBoundaries: null,
        authority: null,
        observations: null,
        app: previous,
        appDraft: null,
        appRevision: 0,
        live,
        draft: null,
        dirty: new Set(),
        effects: [],
        read: null,
        readRetirement: null
      }
      stage = prepared
      let result: Result
      try {
        result = operation(transaction)
        for (const { sessionId, target } of removedStructuredReaders(previous, prepared.app)) {
          transaction.retireReadOwner(sessionId, target)
        }
        for (const key of prepared.dirty) {
          if (shallow(previousLive[key], prepared.draft?.[key])) {
            if (prepared.draft && previousLive[key]) {
              prepared.draft[key] = previousLive[key]
            }
            prepared.dirty.delete(key)
          }
        }
        const nextLive = prepared.dirty.size > 0 ? (prepared.draft ?? live) : live
        if (prepared.readRetirement) {
          prepared.effects.push(...prepared.readRetirement.effects)
        }
        stage = null
        if (
          prepared.app !== previous ||
          nextLive !== live ||
          prepared.readRetirement ||
          prepared.purge.length > 0 ||
          prepared.authority ||
          prepared.observations ||
          prepared.mirrorBoundaries ||
          prepared.effects.length > 0
        ) {
          const publish = observers.prepare(
            () => joined(previous, previousLive),
            () => joined(prepared.app, nextLive),
            prepared.dirty,
            prepared.effects
          )
          const accept = () => {
            prepared.accepted = true
            publish()
          }
          coordinatedDepth++
          try {
            const install = prepared.app !== previous ? { app: prepared.app, accept } : null
            pending = install
            for (const purge of prepared.purge) {
              purge.install()
            }
            live = nextLive
            mirrorBoundaries = prepared.mirrorBoundaries ?? mirrorBoundaries
            authority = prepared.authority ?? authority
            observations = prepared.observations ?? observations
            if (prepared.readRetirement) {
              installStructuredReadRetirement(prepared.readRetirement)
            }
            if (install) {
              appDepth++
              try {
                rawSet(prepared.app, true)
              } finally {
                appDepth--
              }
            } else {
              accept()
            }
          } finally {
            if (appDepth === 0) {
              observers.drain()
            }
            coordinatedDepth--
          }
        } else {
          prepared.accepted = true
        }
        return result
      } finally {
        stage = null
      }
    }
  }
  return owner
}

export function withAgentStatusCommit(
  createState: StateCreator<AppState, [], []>
): StateCreator<AppState, [], []> {
  return (set, get, api) => {
    const owner = createAgentStatusOwner(set, get)
    owners.set(api.getState, owner)
    owners.set(owner.getAppState, owner)
    owners.set(owner.getTransactionState, owner)
    bindTerminalFactGetters(owner, get, owner.getAppState)
    api.subscribe(owner.receipt)
    const subscribe = api.subscribe
    api.subscribe = (listener) =>
      subscribe((...args) => {
        if (!owner.isCoordinated()) {
          listener(...args)
          return
        }
        try {
          listener(...args)
        } catch (error) {
          reportAgentStatusObserverError(error)
        }
      })
    api.setState = owner.write
    const state = createState(owner.write, owner.getAppState, api)
    actionOwners.set(state.transferAgentPaneAuthority, owner)
    return state
  }
}
