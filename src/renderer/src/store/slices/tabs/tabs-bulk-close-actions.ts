import { workerTabStripOrder } from '../../../../../shared/workspace-layout/tab-groups/worker-tab-strip-order'
import { selectWorkerTabPeekId } from '@/components/tab-bar/worker-tab-presentation'
import {
  hideWorkerTabInStore,
  workerTabCloseKind,
  type WorkerTabCloseKind
} from '@/components/tab-bar/worker-tab-view-actions'
import { selectFoldedWorkerTabIds } from '@/components/tab-bar/worker-tab-folding'
import {
  afterPendingTabs,
  isPendingTab,
  isTabClosePending
} from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { editorTabsRetirement } from '../editor/tabs/editor-tab-retirement'
import { editorTabWorkspace } from '../editor/tabs/workspace-editor-files'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findGroupForTab, findTabAndWorktree } from './tab-group-state'

export function createTabsBulkCloseActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'closeUnifiedTabs' | 'closeOtherTabs' | 'closeTabsToRight' | 'closeTabsToLeft'> {
  const closeInDirection = (tabId: string, direction: 'left' | 'right'): string[] => {
    const state = get()
    const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
    if (!found) {
      return []
    }
    const { tab, worktreeId } = found
    const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
    if (!group) {
      return []
    }
    const folded = selectFoldedWorkerTabIds(state, worktreeId, group.id)
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const order = workerTabStripOrder(
      group.tabOrder.filter((id) => !folded.has(id)),
      tabs,
      selectWorkerTabPeekId(state, worktreeId, group.id)
    )
    const index = order.indexOf(tabId)
    if (index === -1) {
      return []
    }
    const byId = new Map(tabs.map((tab) => [tab.id, tab]))
    const closable = (
      direction === 'right' ? order.slice(index + 1) : order.slice(0, index)
    ).filter((id) => !byId.get(id)?.isPinned)
    get().closeUnifiedTabs(closable)
    return closable
  }
  return {
    closeUnifiedTabs: (tabIds) => {
      const before = get()
      const selected = new Set(tabIds)
      const workspaceIds = new Set(
        tabIds.flatMap((id) => {
          const workspaceId = editorTabWorkspace(before.unifiedTabsByWorktree, id)
          return workspaceId ? [workspaceId] : []
        })
      )
      const tabs = [...workspaceIds].flatMap((id) =>
        (before.unifiedTabsByWorktree[id] ?? []).filter(
          (tab) => selected.has(tab.id) && !isTabClosePending(tab.id)
        )
      )
      const workerKinds = new Map<string, WorkerTabCloseKind>()
      for (const tab of tabs) {
        if (tab.workerTab) {
          workerKinds.set(tab.id, workerTabCloseKind(before, tab))
        }
      }
      const kept = [...workerKinds.values()].filter((kind) => kind === 'mixed').length
      if (kept > 0) {
        // UI notes load only when a bulk close actually keeps a tab, after store construction.
        void import('@/components/tab-bar/worker-tab-user-close')
          .then(({ announceKeptMixedWorkerTabs }) =>
            announceKeptMixedWorkerTabs(before, [...workerKinds.keys()])
          )
          .catch((error) => console.error('Worker tab close note failed', error))
      }
      const retire = editorTabsRetirement(set, get, before, tabs)
      for (const tab of tabs) {
        const kind = workerKinds.get(tab.id) ?? 'none'
        if (kind === 'mixed') {
          continue
        }
        if (kind === 'pure') {
          if (tab.isPinned || before.workerTabsMode === 'always-open') {
            continue
          }
          const hidden = hideWorkerTabInStore(get, tab.id)
          if (hidden) {
            void import('@/components/tab-bar/worker-tab-hide')
              .then(({ notifyWorkerTabHidden }) => notifyWorkerTabHidden(hidden))
              .catch((error) => console.error('Worker tab hide note failed', error))
          }
          continue
        }
        get().closeUnifiedTab(tab.id, { editorRetirementHandled: true })
      }
      const retireAfterAnswers = (): void => {
        const pending = tabs.filter((tab) => isPendingTab(tab.id)).map((tab) => tab.id)
        if (pending.length > 0) {
          afterPendingTabs(pending, retireAfterAnswers)
        } else {
          retire()
        }
      }
      retireAfterAnswers()
    },
    closeOtherTabs: (tabId) => {
      const state = get()
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return []
      }
      const { tab, worktreeId } = found
      const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      if (!group) {
        return []
      }
      const folded = selectFoldedWorkerTabIds(state, worktreeId, group.id)
      const closedIds = (state.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter(
          (item) =>
            item.groupId === group.id && item.id !== tabId && !item.isPinned && !folded.has(item.id)
        )
        .map((item) => item.id)
      get().closeUnifiedTabs(closedIds)
      return closedIds
    },

    closeTabsToRight: (tabId) => closeInDirection(tabId, 'right'),
    closeTabsToLeft: (tabId) => closeInDirection(tabId, 'left')
  }
}
