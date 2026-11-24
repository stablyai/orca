import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { requestWorkerTabClose } from './WorkerTabConfirmDialog'
import { hideWorkerTab } from './worker-tab-hide'
import { selectFoldedWorkerTabIds } from './worker-tab-folding'
import { workerTabCloseKind } from './worker-tab-view-actions'

// Close gestures this window admits never close, move or detach anything that holds a worker:
// a pure worker tab hides, and a pane or tab mixing a worker with the user's content stays open with a note.

function findTab(state: AppState, id: string): { tab: Tab; worktreeId: string } | null {
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const tab = tabs.find(
      (candidate) =>
        candidate.id === id || (candidate.contentType === 'terminal' && candidate.entityId === id)
    )
    if (tab) {
      return { tab, worktreeId }
    }
  }
  return null
}

function notifyMixedWorkerTabKept(tabId: string): void {
  // One id per tab: repeated Cmd/Ctrl+W refreshes the same note instead of stacking more.
  toast(
    translate('workerTabs.closeKept.tab', 'This tab has a worker · close your terminal pane first'),
    { id: `worker-tab-kept:${tabId}` }
  )
}

/** A user close (×, Cmd/Ctrl+W, own close) of a stamped tab; true when it was handled here. */
export function handleWorkerTabUserClose(id: string, bulk = false): boolean {
  const state = useAppStore.getState()
  const found = findTab(state, id)
  if (!found) {
    return false
  }
  const { tab, worktreeId } = found
  const kind = workerTabCloseKind(state, tab)
  if (kind === 'none') {
    return false
  }
  if (kind === 'mixed') {
    // A bulk close already said how many it kept, once, when it chose its targets.
    if (!bulk) {
      notifyMixedWorkerTabKept(tab.id)
    }
    return true
  }
  if (bulk && tab.isPinned) {
    return true
  }
  if (state.workerTabsMode === 'always-open') {
    if (!bulk) {
      requestWorkerTabClose(worktreeId, tab)
    }
    return true
  }
  hideWorkerTab(tab.id)
  return true
}

/** One note for a bulk close, counted when it chose its targets; later changes add nothing. */
export function announceKeptMixedWorkerTabs(state: AppState, tabIds: readonly string[]): void {
  const seen = new Set<string>()
  for (const id of tabIds) {
    const found = findTab(state, id)
    if (found && workerTabCloseKind(state, found.tab) === 'mixed') {
      seen.add(found.tab.id)
    }
  }
  if (seen.size === 0) {
    return
  }
  toast(
    translate('workerTabs.closeKept.bulk', 'Kept {{count}} tabs with workers', {
      count: seen.size
    }),
    { id: `worker-tabs-kept:${createNonSecureContextUuid()}` }
  )
}

function paneTabs(state: AppState, worktreeId: string, groupId: string): Tab[] {
  const group = state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === groupId)
  const order = new Set(group?.tabOrder ?? [])
  // Order and membership can disagree mid-update; either one puts a tab in this pane.
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.groupId === groupId || order.has(tab.id)
  )
}

/** Peek the pane's most recent folded worker, re-checked when the user clicks Show. */
function showFoldedWorker(worktreeId: string, groupId: string): void {
  const state = useAppStore.getState()
  const group = state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === groupId)
  if (!group) {
    return
  }
  const folded = selectFoldedWorkerTabIds(state, worktreeId, groupId)
  const inPane = new Set(
    paneTabs(state, worktreeId, groupId)
      .filter((tab) => tab.groupId === groupId && tab.workerTab && folded.has(tab.id))
      .map((tab) => tab.id)
  )
  const recent = group.recentTabIds ?? []
  let pick: string | undefined
  for (let index = recent.length - 1; index >= 0 && !pick; index--) {
    if (inPane.has(recent[index]!)) {
      pick = recent[index]
    }
  }
  pick ??= group.tabOrder.find((id) => inPane.has(id))
  if (pick) {
    state.activateTab(pick, { worktreeId })
  }
}

/** Close split pane on a pane holding any worker, folded or visible: keep it all and say why. */
export function keepWorkerPaneOnClose(worktreeId: string, groupId: string): boolean {
  const state = useAppStore.getState()
  const workers = paneTabs(state, worktreeId, groupId).filter(
    (tab) => workerTabCloseKind(state, tab) !== 'none'
  )
  if (workers.length === 0) {
    return false
  }
  const folded = selectFoldedWorkerTabIds(state, worktreeId, groupId)
  const canShow = workers.some((tab) => folded.has(tab.id))
  const count = workers.length
  toast(
    translate(
      'workerTabs.closeKept.pane',
      'This pane has {{count}} workers · stop or close them first',
      {
        count
      }
    ),
    {
      id: `worker-pane-kept:${groupId}`,
      ...(canShow
        ? {
            action: {
              label: translate('workerTabs.hideToast.show', 'Show'),
              onClick: () => showFoldedWorker(worktreeId, groupId)
            }
          }
        : {})
    }
  )
  return true
}
