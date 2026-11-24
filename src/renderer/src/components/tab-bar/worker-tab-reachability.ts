import { workerTabExecutionHost } from './worker-tab-execution-host'
import { workerTabPaneKey } from './worker-tab-run-state'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '@/store/types'
import { getSharedWorktreeAgentRowsSelector } from '@/components/sidebar/workspace-card/activity/worktree-agent-rows-projection'

import {
  workerRowMembershipInputsUnchanged,
  captureWorkerRowMembership,
  type WorkerRowMembershipSnapshot
} from './worker-tab-reachability-inputs'

const EMPTY_TABS: readonly Tab[] = []

type ReachableCache = {
  membership: WorkerRowMembershipSnapshot
  rows: unknown
  set: ReadonlySet<string>
  hostId: ReturnType<typeof workerTabExecutionHost>
  selector: ReturnType<typeof getSharedWorktreeAgentRowsSelector>
}
const reachableCache = new Map<string, ReachableCache>()

/** Tabs the sidebar can lead back to: the emitted row set, stable while membership is unchanged. */
export function selectReachableWorkerPaneKeys(
  state: AppState,
  worktreeId: string
): ReadonlySet<string> {
  const hostId = workerTabExecutionHost(state, worktreeId)
  const cached = reachableCache.get(worktreeId)
  if (cached?.hostId === hostId && workerRowMembershipInputsUnchanged(cached.membership, state)) {
    return cached.set
  }
  return projectReachableWorkerPaneKeys(state, worktreeId, hostId, cached)
}

function projectReachableWorkerPaneKeys(
  state: AppState,
  worktreeId: string,
  hostId: ReturnType<typeof workerTabExecutionHost>,
  cached: ReachableCache | undefined
): ReadonlySet<string> {
  const selector =
    cached?.hostId === hostId
      ? cached.selector
      : getSharedWorktreeAgentRowsSelector(worktreeId, hostId ?? undefined)
  const rows = selector(state)
  if (cached) {
    cached.membership = captureWorkerRowMembership(state)
    cached.hostId = hostId
    cached.selector = selector
  }
  if (cached?.rows === rows) {
    return cached.set
  }
  if (cached && rows.length === cached.set.size) {
    let same = true
    for (let index = 0; index < rows.length; index++) {
      if (!cached.set.has(rows[index]!.paneKey)) {
        same = false
        break
      }
    }
    if (same) {
      cached.rows = rows
      return cached.set
    }
  }
  const set = new Set(rows.map((row) => row.paneKey))
  reachableCache.set(worktreeId, {
    membership: captureWorkerRowMembership(state),
    rows,
    set,
    hostId,
    selector
  })
  return set
}

const reachableTabsCache = new Map<
  string,
  { tabs: readonly Tab[]; panes: ReadonlySet<string>; result: ReadonlySet<string> }
>()
export function selectReachableWorkerTabIds(
  state: AppState,
  worktreeId: string
): ReadonlySet<string> {
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS
  const panes = selectReachableWorkerPaneKeys(state, worktreeId)
  const cached = reachableTabsCache.get(worktreeId)
  if (cached?.tabs === tabs && cached.panes === panes) {
    return cached.result
  }
  return projectReachableWorkerTabIds(tabs, panes, worktreeId, cached)
}

function projectReachableWorkerTabIds(
  tabs: readonly Tab[],
  panes: ReadonlySet<string>,
  worktreeId: string,
  cached:
    | { tabs: readonly Tab[]; panes: ReadonlySet<string>; result: ReadonlySet<string> }
    | undefined
): ReadonlySet<string> {
  const next = new Set<string>()
  for (const tab of tabs) {
    const paneKey = workerTabPaneKey(tab)
    if (paneKey && panes.has(paneKey)) {
      next.add(tab.id)
    }
  }
  const result =
    cached && cached.result.size === next.size && [...next].every((id) => cached.result.has(id))
      ? cached.result
      : next
  reachableTabsCache.set(worktreeId, { tabs, panes, result })
  return result
}

export function forgetWorkerTabReachability(worktreeId: string): void {
  reachableCache.delete(worktreeId)
  reachableTabsCache.delete(worktreeId)
}
