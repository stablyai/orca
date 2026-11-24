import { indexedWorkerTab } from './worker-tab-index'
import { workerTabCloseKind } from './worker-tab-view-actions'
import { workerTabHasNewAgent } from '../../../../shared/orchestration/workers/worker-tab-agent-identity'
import type { IndexedCoordinatorTab } from './coordinator-tab-identities'
import { coordinatorWorkerIndex, type IndexedCoordinatorWorker } from './coordinator-worker-index'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { currentWorkerLineage } from '../../../../shared/orchestration/workers/worker-tab-stamp'

/** How the strip draws a worker tab; 'none' for every other tab. */
export type WorkerTabStripState = 'none' | 'peek' | 'kept' | 'worker'

export function selectWorkerTabStripState(
  state: AppState,
  worktreeId: string,
  groupId: string,
  unifiedTabId: string
): WorkerTabStripState {
  if (state.workerTabsMode === 'always-open') {
    return 'none'
  }
  const tab = indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], unifiedTabId)
  // Only a worker-only tab peeks, keeps or hides; one holding the user's pane is drawn as an ordinary tab.
  if (!tab || workerTabCloseKind(state, tab) !== 'pure') {
    return 'none'
  }
  if (state.workerTabStripChoiceByWorktree[worktreeId]?.[unifiedTabId] === 'kept') {
    return 'kept'
  }
  const group = (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === groupId)
  if (
    state.workerTabPeekByGroupId[groupId] === unifiedTabId ||
    group?.activeTabId === unifiedTabId
  ) {
    return 'peek'
  }
  return 'worker'
}

/** Worker states in the coordinator's list, in the order the list shows them. */
export type WorkerListState = 'needs-you' | 'failed' | 'running' | 'done' | 'stopped'

export const WORKER_LIST_STATE_ORDER: readonly WorkerListState[] = [
  'needs-you',
  'failed',
  'running',
  'done',
  'stopped'
]

export function workerListState(
  context: AgentStatusOrchestrationContext | undefined
): WorkerListState {
  if (context?.stopped) {
    return 'stopped'
  }
  if (context?.attention?.requiresAction) {
    return 'needs-you'
  }
  const status = context?.dispatchStatus
  if (status === 'failed' || status === 'circuit_broken') {
    return 'failed'
  }
  if (status === 'completed') {
    return 'done'
  }
  return 'running'
}

export type CoordinatorWorkerEntry = {
  tab: Tab
  worktreeId: string
  state: WorkerListState
  title: string
  /** The intermediate parent's title, when the worker reports through a helper. */
  viaTitle: string | null
  /** The parent closed and its projection expired; only the Run coordinator is still known. */
  viaClosedWorker: boolean
}

function workerTitle(tab: Tab, context: AgentStatusOrchestrationContext | undefined): string {
  const lineage = tab.workerTab ? currentWorkerLineage(tab.workerTab) : undefined
  return (
    tab.customLabel?.trim() ||
    tab.quickCommandLabel?.trim() ||
    (tab.workerTab && workerTabHasNewAgent(tab.workerTab) ? tab.label : '') ||
    context?.taskTitle?.trim() ||
    lineage?.taskTitle?.trim() ||
    tab.label
  )
}

type WorkerListMemo = {
  identities: number
  generation: number
  members: number
  value: WeakRef<readonly CoordinatorWorkerEntry[]>
}
const workerLists = new WeakMap<IndexedCoordinatorTab, WorkerListMemo>()
const EMPTY_ENTRIES: readonly CoordinatorWorkerEntry[] = []

function coordinatorWorkerEntry(
  worker: IndexedCoordinatorWorker,
  coordinator: IndexedCoordinatorTab
): CoordinatorWorkerEntry {
  const index = coordinatorWorkerIndex
  const tab = worker.tab
  const context = worker.context
  const lineage = tab.workerTab ? currentWorkerLineage(tab.workerTab) : undefined
  const parent = index.identities.resolve(context?.parentIdentity ?? lineage?.parent)
  let via: { title: string | null; closed: boolean } | undefined
  const resolveVia = () => {
    if (via) {
      return via
    }
    via = { title: null, closed: false }
    const seen = new Set([tab.id])
    let hop = parent
    for (let depth = 0; hop && hop.tab.id !== coordinator.tab.id; depth++) {
      if (depth >= 32 || seen.has(hop.tab.id)) {
        return via
      }
      seen.add(hop.tab.id)
      const next =
        index.workers.get(hop)?.context?.parentIdentity ??
        (hop.tab.workerTab && currentWorkerLineage(hop.tab.workerTab).parent)
      hop = next ? index.identities.resolve(next) : undefined
    }
    via = {
      title:
        parent && parent.tab.id !== coordinator.tab.id
          ? workerTitle(parent.tab, index.workers.get(parent)?.context)
          : null,
      closed: !parent
    }
    return via
  }
  return {
    tab,
    worktreeId: worker.entry.worktreeId,
    state: workerListState(context),
    title: workerTitle(tab, context),
    get viaTitle() {
      return resolveVia().title
    },
    get viaClosedWorker() {
      return resolveVia().closed
    }
  }
}

export function selectCoordinatorWorkers(
  state: AppState,
  coordinatorTabId: string
): readonly CoordinatorWorkerEntry[] {
  const index = coordinatorWorkerIndex
  index.update(state)
  const coordinator = index.identities.byAlias(coordinatorTabId)
  if (!coordinator || !index.hasWorkers(coordinator)) {
    return EMPTY_ENTRIES
  }
  const members = index.memberVersion(coordinator)
  const previous = workerLists.get(coordinator)
  if (
    previous?.identities === index.identities.revision &&
    previous.generation === index.buckets.generation &&
    previous.members === members
  ) {
    const retained = previous.value.deref()
    if (retained) {
      return retained
    }
  }
  const result = Array.from(index.members(coordinator), (worker) =>
    coordinatorWorkerEntry(worker, coordinator)
  )
  result.sort(
    (left, right) =>
      WORKER_LIST_STATE_ORDER.indexOf(left.state) - WORKER_LIST_STATE_ORDER.indexOf(right.state) ||
      right.tab.createdAt - left.tab.createdAt
  )
  workerLists.set(coordinator, {
    identities: index.identities.revision,
    generation: index.buckets.generation,
    members,
    value: new WeakRef(result)
  })
  return result
}

export function selectCoordinatorNeedsYouCount(state: AppState, coordinatorTabId: string): number {
  coordinatorWorkerIndex.update(state)
  const entry = coordinatorWorkerIndex.identities.byAlias(coordinatorTabId)
  return entry ? coordinatorWorkerIndex.needsYou(entry) : 0
}

export function selectCoordinatorHasWorkers(state: AppState, coordinatorTabId: string): boolean {
  coordinatorWorkerIndex.update(state)
  const entry = coordinatorWorkerIndex.identities.byAlias(coordinatorTabId)
  return Boolean(entry && coordinatorWorkerIndex.hasWorkers(entry))
}

export function selectWorkerTabPeekId(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'> &
    Partial<
      Pick<AppState, 'workerTabStripChoiceByWorktree' | 'workerTabPeekByGroupId' | 'workerTabsMode'>
    >,
  worktreeId: string,
  groupId: string
): string | undefined {
  if (state.workerTabsMode === 'always-open') {
    return undefined
  }
  const activeId = state.groupsByWorktree[worktreeId]?.find(
    (group) => group.id === groupId
  )?.activeTabId
  const active = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === activeId)
  return active?.workerTab &&
    state.workerTabStripChoiceByWorktree?.[worktreeId]?.[active.id] !== 'kept'
    ? active.id
    : state.workerTabPeekByGroupId?.[groupId]
}
