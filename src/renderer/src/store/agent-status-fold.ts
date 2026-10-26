import {
  countLiveAgentStatuses,
  noteLiveAgentStatusCount
} from './slices/agent-status-capacity-eviction'
import type { createAgentPaneAuthority } from './slices/agent-pane-authority'
import type { AgentStatusObservationSequencer } from '../../../shared/agent-status-observation'
import type { HostWorkingClientBoundary } from '../runtime/web-session-tabs-sync/state'
import type { RemovalNoticeRoot } from './slices/worktrees/teardown/removed-workspace-unsaved-files'
import type { PreparedPurgeOwnership } from './slices/worktrees/teardown/worktree-purge-preparation'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from './types'
import type { AgentStatusEntry } from './slices/agent-status-contract'
import type { AgentStatusReadState, AgentStatusSnapshot } from './agent-status-observers'
import type { StoreSetArgs } from './react-commit-cascade-write-probe'
import { prepareStructuredReadRetirement } from '../components/native-chat/structured-agent-session-read-owner-registry'

export type AgentStatusTransaction = {
  captureAcceptance: () => () => boolean
  getState: () => AgentStatusReadState
  retireReadOwner: (sessionId: string, target: RuntimeClientTarget) => void
  editEntries: (edit: (entries: Record<string, AgentStatusEntry>) => readonly string[]) => void
  setEntry: (paneKey: string, entry: AgentStatusEntry | undefined) => void
  afterCommit: (effect: () => void) => void
}
export type StatusStage = {
  accepted: boolean
  authority: ReturnType<typeof createAgentPaneAuthority> | null
  observations: AgentStatusObservationSequencer | null
  mirrorBoundaries: Map<string, HostWorkingClientBoundary> | null
  notice: RemovalNoticeRoot | null
  purgedLaunches: Set<string>
  purge: PreparedPurgeOwnership[]
  app: AppState
  appDraft: AppState | null
  appRevision: number
  live: AgentStatusSnapshot
  draft: Record<string, AgentStatusEntry> | null
  dirty: Set<string>
  effects: (() => void)[]
  readRetirement: ReturnType<typeof prepareStructuredReadRetirement> | null
  read: AgentStatusReadState | null
}
type AgentStatusReadProperties = { [Key in keyof AppState]: AppState[Key] }

function createAgentStatusReadView(
  app: () => AppState,
  statuses: () => AgentStatusSnapshot
): AgentStatusReadState {
  const read = (key: PropertyKey): unknown => {
    if (key === 'agentStatusByPaneKey') {
      return statuses()
    }
    const source: AgentStatusReadProperties = app()
    const properties: Readonly<Record<PropertyKey, unknown>> = source
    return properties[key]
  }
  const refuse = () => false
  return new Proxy<AgentStatusReadState>(Object.create(Object.prototype), {
    get: (_target, key, receiver) => {
      if (
        key === 'agentStatusByPaneKey' ||
        Object.getOwnPropertyDescriptor(app(), key)?.enumerable
      ) {
        return read(key)
      }
      const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, key)
      return descriptor?.get ? descriptor.get.call(receiver) : descriptor?.value
    },
    has: (_target, key) =>
      key === 'agentStatusByPaneKey' ||
      Object.getOwnPropertyDescriptor(app(), key)?.enumerable === true ||
      Reflect.has(Object.prototype, key),
    ownKeys: () => {
      const source = app()
      const keys = Reflect.ownKeys(source).filter(
        (key) => Object.getOwnPropertyDescriptor(source, key)?.enumerable
      )
      return [
        ...keys.filter((key) => typeof key === 'string' && key !== 'agentStatusByPaneKey'),
        'agentStatusByPaneKey',
        ...keys.filter((key) => typeof key === 'symbol')
      ]
    },
    getOwnPropertyDescriptor: (_target, key) =>
      key === 'agentStatusByPaneKey' || Object.getOwnPropertyDescriptor(app(), key)?.enumerable
        ? { configurable: true, enumerable: true, writable: false, value: read(key) }
        : undefined,
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
    setPrototypeOf: refuse,
    preventExtensions: refuse
  })
}

export function readAgentStatusFold(stage: StatusStage): AgentStatusReadState {
  stage.read ??= createAgentStatusReadView(
    () => stage.app,
    () => stage.draft ?? stage.live
  )
  return stage.read
}

export function writeAgentStatusFold(stage: StatusStage, ...args: StoreSetArgs<AppState>): void {
  const current = stage.app
  const next = typeof args[0] === 'function' ? args[0](current) : args[0]
  if (Object.is(next, current)) {
    return
  }
  stage.appDraft ??= { ...current }
  stage.app = stage.appDraft
  if (args[1] === true) {
    // Replacement removes omitted fields from both private views before installation.
    for (const key of Object.keys(stage.app)) {
      if (!(key in next)) {
        Reflect.deleteProperty(stage.app, key)
      }
    }
  }
  Object.assign(stage.app, next)
  stage.appRevision++
}

export function createAgentStatusReadViews() {
  const views = new WeakMap<AppState, WeakMap<AgentStatusSnapshot, AgentStatusReadState>>()
  return (app: AppState, statuses: AgentStatusSnapshot): AgentStatusReadState => {
    let byStatus = views.get(app)
    if (!byStatus) {
      byStatus = new WeakMap()
      views.set(app, byStatus)
    }
    let view = byStatus.get(statuses)
    if (!view) {
      view = createAgentStatusReadView(
        () => app,
        () => statuses
      )
      byStatus.set(statuses, view)
    }
    return view
  }
}

export function createAgentStatusTransaction(
  getStage: () => StatusStage | null,
  readCommitted: () => AgentStatusReadState,
  afterCommit: AgentStatusTransaction['afterCommit']
): AgentStatusTransaction {
  return {
    captureAcceptance: () => {
      const stage = getStage()
      return () => stage?.accepted === true
    },
    getState: () => {
      const stage = getStage()
      if (!stage) {
        return readCommitted()
      }
      return readAgentStatusFold(stage)
    },
    afterCommit,
    retireReadOwner(sessionId, target) {
      const stage = getStage()
      if (!stage) {
        throw new Error('Reader retirement requires a transaction')
      }
      stage.readRetirement = prepareStructuredReadRetirement(
        stage.readRetirement,
        sessionId,
        target
      )
    },
    editEntries(edit) {
      const stage = getStage()
      if (!stage) {
        throw new Error('Live status writes require a transaction')
      }
      if (!stage.draft) {
        stage.draft = { ...stage.live }
        Object.setPrototypeOf(stage.draft, null)
        noteLiveAgentStatusCount(stage.draft, countLiveAgentStatuses(stage.live))
      }
      for (const key of edit(stage.draft)) {
        stage.dirty.add(key)
      }
    },
    setEntry(paneKey, entry) {
      const stage = getStage()
      if (!stage) {
        throw new Error('Live status writes require a transaction')
      }
      if (Object.is((stage.draft ?? stage.live)[paneKey], entry)) {
        return
      }
      if (!stage.draft) {
        stage.draft = { ...stage.live }
        Object.setPrototypeOf(stage.draft, null)
        noteLiveAgentStatusCount(stage.draft, countLiveAgentStatuses(stage.live))
      }
      stage.dirty.add(paneKey)
      const size =
        countLiveAgentStatuses(stage.draft) + (entry ? (paneKey in stage.draft ? 0 : 1) : -1)
      noteLiveAgentStatusCount(stage.draft, size)
      if (entry) {
        stage.draft[paneKey] = entry
      } else {
        delete stage.draft[paneKey]
      }
    }
  }
}
