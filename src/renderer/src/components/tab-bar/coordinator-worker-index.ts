import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  agentPublicIdentitiesEqual,
  currentWorkerLineage,
  type AgentPublicIdentity
} from '../../../../shared/orchestration/workers/worker-tab-stamp'
import {
  CoordinatorTabIdentityIndex,
  type IndexedCoordinatorTab
} from './coordinator-tab-identities'
import { CoordinatorContextIndex } from './coordinator-context-index'
import {
  CoordinatorWorkerBuckets,
  coordinatorWorkerRoute,
  type CoordinatorWorkerBucket,
  type CoordinatorWorkerRoute
} from './coordinator-worker-buckets'
import { workerTabContext } from './worker-tab-run-state'
import {
  workerRowMembershipInputsUnchanged,
  captureWorkerRowMembership,
  type WorkerRowMembershipSnapshot
} from './worker-tab-reachability-inputs'

export type IndexedCoordinatorWorker = {
  entry: IndexedCoordinatorTab
  tab: Tab
  context: AgentStatusOrchestrationContext | undefined
  identity: AgentPublicIdentity | undefined
  route: CoordinatorWorkerRoute | null
  needsYou: boolean
  buckets: readonly CoordinatorWorkerBucket<IndexedCoordinatorWorker>[]
}

export class CoordinatorWorkerIndex {
  readonly identities = new CoordinatorTabIdentityIndex()
  readonly buckets = new CoordinatorWorkerBuckets<IndexedCoordinatorWorker>()
  readonly workers = new Map<IndexedCoordinatorTab, IndexedCoordinatorWorker>()
  private tabs: AppState['unifiedTabsByWorktree'] | undefined
  private layouts: AppState['terminalLayoutsByTabId'] | undefined
  private statuses: AppState['agentStatusByPaneKey'] | undefined
  private orchestration: AppState['runtimeAgentOrchestrationByPaneKey'] | undefined
  private membership: WorkerRowMembershipSnapshot | undefined
  private readonly workspaceTabs = new Map<string, readonly Tab[]>()
  private readonly pending = new Set<IndexedCoordinatorTab>()
  private readonly runtime = new CoordinatorContextIndex<AgentStatusOrchestrationContext>(
    (value) => value
  )
  private readonly live = new CoordinatorContextIndex<AgentStatusEntry>(
    (value) => value?.orchestration
  )
  private readonly mark = (entry: IndexedCoordinatorTab) => {
    this.pending.add(entry)
  }
  private readonly markUnstamped = (entry: IndexedCoordinatorTab) => {
    if (!entry.tab.workerTab) {
      this.pending.add(entry)
    }
  }
  private readonly changedContext = (id: string, valueChanged: boolean) => {
    this.identities.forEachAlias(id, valueChanged ? this.mark : this.markUnstamped)
  }

  update(state: AppState): void {
    if (this.membership && workerRowMembershipInputsUnchanged(this.membership, state)) {
      return
    }
    if (
      this.tabs === state.unifiedTabsByWorktree &&
      this.layouts === state.terminalLayoutsByTabId &&
      this.statuses === state.agentStatusByPaneKey &&
      this.orchestration === state.runtimeAgentOrchestrationByPaneKey
    ) {
      this.membership = captureWorkerRowMembership(state)
      return
    }
    this.pending.clear()
    if (this.tabs !== state.unifiedTabsByWorktree) {
      this.syncTabs(state)
    }
    this.identities.syncLayouts(state)
    this.runtime.update(state.runtimeAgentOrchestrationByPaneKey, this.changedContext)
    this.live.updateMap(
      state.agentStatusByPaneKey,
      state.agentStatusByPaneKey.projection,
      this.changedContext
    )
    for (const entry of this.pending) {
      this.refresh(state, entry)
    }
    this.pending.clear()
    this.tabs = state.unifiedTabsByWorktree
    this.layouts = state.terminalLayoutsByTabId
    this.statuses = state.agentStatusByPaneKey
    this.orchestration = state.runtimeAgentOrchestrationByPaneKey
    this.membership = captureWorkerRowMembership(state)
  }

  needsYou(entry: IndexedCoordinatorTab): number {
    if (entry.tab.contentType === 'agent-session') {
      const root = entry.tab.agentSessionLineageRootId ?? entry.tab.entityId
      return this.identities.bySessionRoot(root) === entry
        ? (this.buckets.sessions.get(root)?.needsYou ?? 0)
        : 0
    }
    let count = 0
    for (const leaf of entry.leaves) {
      if (this.identities.byLeaf(leaf) === entry) {
        count += this.buckets.leaves.get(leaf)?.needsYou ?? 0
      }
    }
    if (!entry.root && this.identities.byTerminalEntity(entry.tab.entityId) === entry) {
      count +=
        this.buckets.entities.get(entry.tab.entityId)?.unresolvedNeedsYou(this.identities) ?? 0
    }
    return count
  }

  memberVersion(entry: IndexedCoordinatorTab): number {
    if (entry.tab.contentType === 'agent-session') {
      return (
        this.buckets.sessions.get(entry.tab.agentSessionLineageRootId ?? entry.tab.entityId)
          ?.version ?? 0
      )
    }
    let version = !entry.root ? (this.buckets.entities.get(entry.tab.entityId)?.version ?? 0) : 0
    for (const leaf of entry.leaves) {
      version += this.buckets.leaves.get(leaf)?.version ?? 0
    }
    return version
  }

  hasWorkers(entry: IndexedCoordinatorTab): boolean {
    if (entry.tab.contentType === 'agent-session') {
      const root = entry.tab.agentSessionLineageRootId ?? entry.tab.entityId
      return (
        this.identities.bySessionRoot(root) === entry &&
        Boolean(this.buckets.sessions.get(root)?.members.size)
      )
    }
    for (const leaf of entry.leaves) {
      if (this.identities.byLeaf(leaf) === entry && this.buckets.leaves.get(leaf)?.members.size) {
        return true
      }
    }
    return (
      !entry.root &&
      this.identities.byTerminalEntity(entry.tab.entityId) === entry &&
      Boolean(this.buckets.entities.get(entry.tab.entityId)?.unresolvedMembers(this.identities))
    )
  }

  members(entry: IndexedCoordinatorTab): ReadonlySet<IndexedCoordinatorWorker> {
    const members = new Set<IndexedCoordinatorWorker>()
    if (entry.tab.contentType === 'agent-session') {
      const root = entry.tab.agentSessionLineageRootId ?? entry.tab.entityId
      if (this.identities.bySessionRoot(root) === entry) {
        for (const worker of this.buckets.sessions.get(root)?.members ?? []) {
          members.add(worker)
        }
      }
      return members
    }
    for (const leaf of entry.leaves) {
      if (this.identities.byLeaf(leaf) === entry) {
        for (const worker of this.buckets.leaves.get(leaf)?.members ?? []) {
          members.add(worker)
        }
      }
    }
    if (!entry.root && this.identities.byTerminalEntity(entry.tab.entityId) === entry) {
      for (const worker of this.buckets.entities.get(entry.tab.entityId)?.members ?? []) {
        if (worker.route?.kind === 'pane' && !this.identities.byLeaf(worker.route.leafId)) {
          members.add(worker)
        }
      }
    }
    return members
  }

  private syncTabs(state: AppState): void {
    let order = 0
    let orderChanged = false
    for (const worktreeId in state.unifiedTabsByWorktree) {
      if (this.identities.workspaceOrder.get(worktreeId) !== order) {
        orderChanged = true
      }
      this.identities.workspaceOrder.set(worktreeId, order++)
      const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
      const previous = this.workspaceTabs.get(worktreeId)
      if (previous === tabs) {
        continue
      }
      const ids = new Set<string>()
      for (let position = 0; position < tabs.length; position++) {
        const tab = tabs[position]!
        ids.add(tab.id)
        if (previous?.[position] === tab) {
          continue
        }
        const entry = this.identities.upsert(state, tab, worktreeId, position)
        this.mark(entry)
        this.identities.forEachAlias(tab.id, this.markUnstamped)
        this.identities.forEachAlias(tab.entityId, this.markUnstamped)
      }
      for (const tab of previous ?? []) {
        if (!ids.has(tab.id)) {
          this.removeTab(worktreeId, tab)
        }
      }
      this.workspaceTabs.set(worktreeId, tabs)
    }
    for (const [worktreeId, tabs] of this.workspaceTabs) {
      if (!(worktreeId in state.unifiedTabsByWorktree)) {
        for (const tab of tabs) {
          this.removeTab(worktreeId, tab)
        }
        this.workspaceTabs.delete(worktreeId)
        this.identities.workspaceOrder.delete(worktreeId)
        orderChanged = true
      }
    }
    if (orderChanged) {
      this.identities.revision++
    }
  }

  private removeTab(worktreeId: string, tab: Tab): void {
    const entry = this.identities.entries.get(`${worktreeId}\0${tab.id}`)
    if (!entry) {
      return
    }
    const worker = this.workers.get(entry)
    if (worker) {
      this.buckets.remove(worker, worker.buckets)
      this.workers.delete(entry)
    }
    this.pending.delete(entry)
    this.identities.remove(entry)
    this.identities.forEachAlias(tab.id, this.markUnstamped)
    this.identities.forEachAlias(tab.entityId, this.markUnstamped)
  }

  private refresh(state: AppState, entry: IndexedCoordinatorTab): void {
    const tab = entry.tab
    const context = tab.workerTab
      ? workerTabContext(state, tab)
      : (this.runtime.first(entry, this.identities) ?? this.live.first(entry, this.identities))
    let worker = this.workers.get(entry)
    if (!tab.workerTab && !context?.coordinatorIdentity) {
      if (worker) {
        this.buckets.remove(worker, worker.buckets)
        this.workers.delete(entry)
      }
      return
    }
    const identity =
      context?.coordinatorIdentity ??
      (tab.workerTab ? currentWorkerLineage(tab.workerTab).coordinator : undefined)
    const needsYou = !context?.stopped && context?.attention?.requiresAction === true
    const sameIdentity = worker && agentPublicIdentitiesEqual(worker.identity, identity)
    if (worker && worker.tab === tab && worker.context === context && sameIdentity) {
      return
    }
    if (!worker) {
      worker = {
        entry,
        tab,
        context,
        identity,
        route: coordinatorWorkerRoute(identity),
        needsYou,
        buckets: []
      }
      worker.buckets = this.buckets.forRoute(worker.route)
      for (const bucket of worker.buckets) {
        bucket.add(worker)
      }
      this.workers.set(entry, worker)
    } else if (!sameIdentity) {
      this.buckets.remove(worker, worker.buckets)
      worker.tab = tab
      worker.context = context
      worker.identity = identity
      worker.route = coordinatorWorkerRoute(identity)
      worker.needsYou = needsYou
      worker.buckets = this.buckets.forRoute(worker.route)
      for (const bucket of worker.buckets) {
        bucket.add(worker)
      }
    } else {
      const delta = Number(needsYou) - Number(worker.needsYou)
      worker.tab = tab
      worker.context = context
      worker.identity = identity
      worker.needsYou = needsYou
      for (const bucket of worker.buckets) {
        bucket.update(worker, delta)
      }
    }
  }
}

export const coordinatorWorkerIndex = new CoordinatorWorkerIndex()
