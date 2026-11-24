import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { workerTabLeafIds } from './worker-tab-leaves'
import {
  isWorkerChatIdentityConsistent,
  isWorkerTabFoldable,
  isMixedWorkerTab,
  pickVisibleLandingTabId
} from '../../../../shared/workspace-layout/tab-groups/worker-tab-visibility'
import { selectReachableWorkerTabIds, selectFoldedWorkerTabIds } from './worker-tab-folding'
import { workerLeafIds } from '../../../../shared/orchestration/workers/worker-tab-stamp'

export type WorkerTabHideResult = {
  state: AppState
  tab: Tab
  worktreeId: string
  reachable: boolean
}

function findUnifiedTab(state: AppState, id: string): { tab: Tab; worktreeId: string } | null {
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const tab =
      tabs.find((candidate) => candidate.id === id) ??
      tabs.find((candidate) => candidate.contentType === 'terminal' && candidate.entityId === id)
    if (tab) {
      return { tab, worktreeId }
    }
  }
  return null
}

/** A stamped worker tab whose user close should hide it instead: workers only stop by Stop worker or Close tab. */
export function isHideableWorkerTab(state: AppState, tab: Tab): boolean {
  return (
    state.workerTabsMode !== 'always-open' &&
    Boolean(tab.workerTab) &&
    isWorkerTabFoldable(tab, workerTabLeafIds(state, tab))
  )
}

export function isMixedWorkerTabInLayout(state: AppState, tab: Tab): boolean {
  return isMixedWorkerTab(tab, workerTabLeafIds(state, tab))
}

/** How a local close gesture treats a tab: 'none' closes as usual, 'pure' hides, 'mixed' stays open. */
export type WorkerTabCloseKind = 'none' | 'pure' | 'mixed'

/** Read at action time from this window's current layout; a stamped terminal with no layout stays open. */
export function workerTabCloseKind(state: AppState, tab: Tab): WorkerTabCloseKind {
  const stamp = tab.workerTab
  if (!stamp) {
    return 'none'
  }
  if (tab.contentType === 'agent-session') {
    // A chat bound to another agent than the stamp names is not provably the worker's.
    return isWorkerChatIdentityConsistent(tab) ? 'pure' : 'mixed'
  }
  const leafIds = workerTabLeafIds(state, tab)
  if (!leafIds) {
    return 'mixed'
  }
  const owned = workerLeafIds(stamp)
  // The worker's leaf is gone (closed, exited, taken over): the stamp is inert and the tab is the user's.
  if (!leafIds.some((leafId) => owned.has(leafId))) {
    return 'none'
  }
  return leafIds.every((leafId) => owned.has(leafId)) ? 'pure' : 'mixed'
}

/** Fold the tab out of its strip without ending its worker. */
export function hideWorkerTabInStore(
  getState: () => AppState,
  id: string
): WorkerTabHideResult | null {
  const state = getState()
  const found = findUnifiedTab(state, id)
  if (!found || !isHideableWorkerTab(state, found.tab)) {
    return null
  }
  const { tab, worktreeId } = found
  const reachable = selectReachableWorkerTabIds(state, worktreeId).has(tab.id)
  state.setWorkerTabStripChoice(worktreeId, tab.id, 'hidden')
  state.clearWorkerTabPeek(tab.groupId, tab.id)
  const group = (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === tab.groupId)
  if (group?.activeTabId === tab.id) {
    const folded = new Set(selectFoldedWorkerTabIds(getState(), worktreeId, group.id))
    folded.add(tab.id)
    const landing = pickVisibleLandingTabId(group.tabOrder, group.recentTabIds, folded, tab.id)
    if (landing) {
      getState().activateTab(landing, { worktreeId })
    } else {
      getState().clearGroupActiveTab(worktreeId, group.id)
    }
  }
  return { state, tab, worktreeId, reachable }
}

export function keepWorkerTabInState(
  state: AppState,
  worktreeId: string,
  tab: Pick<Tab, 'id' | 'groupId'>
): void {
  state.setWorkerTabStripChoice(worktreeId, tab.id, 'kept')
  state.clearWorkerTabPeek(tab.groupId, tab.id)
}

export function keepPlacedWorkerTabInState(state: AppState, worktreeId: string, id: string): void {
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === id || candidate.entityId === id
  )
  if (tab?.workerTab && state.workerTabStripChoiceByWorktree[worktreeId]?.[tab.id] !== 'kept') {
    keepWorkerTabInState(state, worktreeId, tab)
  }
}
