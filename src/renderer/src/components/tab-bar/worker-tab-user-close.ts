import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { requestWorkerTabClose } from './worker-tab-confirm-request'
import { hideWorkerTab } from './worker-tab-hide'
import { selectFoldedWorkerTabIds } from './worker-tab-folding'
import { workerTabCloseKind } from './worker-tab-view-actions'
import {
  notifyMixedWorkerTabKept,
  resolveWorkerCloseTarget,
  workerCloseKindOf
} from './worker-tab-close-target'

// Close gestures this window admits never close, move or detach anything that holds a worker:
// a pure worker tab hides, and a pane or tab mixing a worker with the user's content stays open with a note.

/** A user close (×, Cmd/Ctrl+W, own close) of a stamped tab; true when it was handled here. */
export function handleWorkerTabUserClose(id: string, bulk = false): boolean {
  const state = useAppStore.getState()
  const target = resolveWorkerCloseTarget(state, id)
  const kind = workerCloseKindOf(state, target)
  if (kind === 'none') {
    return false
  }
  if (kind === 'mixed' || target?.kind !== 'tab') {
    // A bulk close already said how many it kept, once, when it chose its targets.
    if (!bulk) {
      notifyMixedWorkerTabKept(target?.kind === 'tab' ? target.tab.id : id)
    }
    return true
  }
  const { tab, worktreeId } = target
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

function paneTabs(state: AppState, worktreeId: string, groupId: string): Tab[] {
  const group = state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === groupId)
  const order = new Set(group?.tabOrder ?? [])
  // Order and membership can disagree mid-update; either one puts a tab in this pane.
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.groupId === groupId || order.has(tab.id)
  )
}

/** Peek a worker that is still folded, ordered and a member of this pane, on the host it was on
 *  when the note appeared: most recent first, else first in tab order, else nothing. */
export function showFoldedWorkerOfPane(
  worktreeId: string,
  groupId: string,
  hostByTabId: ReadonlyMap<string, Tab['executionHostId']>
): void {
  const state = useAppStore.getState()
  const group = state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === groupId)
  if (!group) {
    return
  }
  const folded = selectFoldedWorkerTabIds(state, worktreeId, groupId)
  const ordered = new Set(group.tabOrder)
  const eligible = new Set(
    (state.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter(
        (tab) =>
          tab.groupId === groupId &&
          ordered.has(tab.id) &&
          folded.has(tab.id) &&
          hostByTabId.has(tab.id) &&
          hostByTabId.get(tab.id) === tab.executionHostId &&
          workerTabCloseKind(state, tab) === 'pure'
      )
      .map((tab) => tab.id)
  )
  const recent = group.recentTabIds ?? []
  let pick: string | undefined
  for (let index = recent.length - 1; index >= 0 && !pick; index--) {
    if (eligible.has(recent[index]!)) {
      pick = recent[index]
    }
  }
  pick ??= group.tabOrder.find((id) => eligible.has(id))
  if (pick) {
    state.activateTab(pick, { worktreeId })
  }
}

/** Close split pane on a pane holding any worker, folded or visible: keep it all and say why. */
export function keepWorkerPaneOnClose(worktreeId: string, groupId: string): boolean {
  const state = useAppStore.getState()
  const workers = new Map<string, Tab>()
  for (const tab of paneTabs(state, worktreeId, groupId)) {
    if (workerTabCloseKind(state, tab) !== 'none') {
      workers.set(tab.id, tab)
    }
  }
  if (workers.size === 0) {
    return false
  }
  const folded = selectFoldedWorkerTabIds(state, worktreeId, groupId)
  const showable = new Map<string, Tab['executionHostId']>()
  for (const tab of workers.values()) {
    if (folded.has(tab.id)) {
      showable.set(tab.id, tab.executionHostId)
    }
  }
  toast(
    translate(
      'workerTabs.closeKept.pane',
      'This pane has {{count}} workers · stop or close them first',
      {
        count: workers.size,
        defaultValue_one: 'This pane has a worker · stop or close it first'
      }
    ),
    {
      id: `worker-pane-kept:${groupId}`,
      ...(showable.size > 0
        ? {
            action: {
              label: translate('workerTabs.hideToast.show', 'Show'),
              onClick: () => showFoldedWorkerOfPane(worktreeId, groupId, showable)
            }
          }
        : {})
    }
  )
  return true
}
