import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TabGroup } from '../../../shared/tab-types'
import type { AppState } from '@/store/types'
import {
  getGroupVisibleTabOrder,
  moveTabIdWithinGroupOrder
} from '@/components/tab-bar/group-tab-order'
import type { TypeCyclableTab } from '@/components/terminal/tab-type-cycle'
import { mirrorWebRuntimeTabMove } from '../components/tab-bar/web-runtime-tab-move-mirror'

type FloatingWorkspaceTabReorderStore = Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'reorderUnifiedTabs'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

function getActiveFloatingWorkspaceGroup(store: FloatingWorkspaceTabReorderStore): TabGroup | null {
  const groups = store.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  const activeGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  if (activeGroupId) {
    const activeGroup = groups.find((group) => group.id === activeGroupId)
    if (activeGroup) {
      return activeGroup
    }
  }
  return groups.find((group) => group.activeTabId != null) ?? groups[0] ?? null
}

function getFloatingWorkspaceVisibleTabIds(
  store: FloatingWorkspaceTabReorderStore,
  group: TabGroup
): string[] {
  const groupTabs = (store.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
    (tab) => tab.groupId === group.id
  )
  const visibleTabs: TypeCyclableTab[] = getGroupVisibleTabOrder(
    group,
    groupTabs,
    new Set((store.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).map((tab) => tab.id)),
    new Set(
      store.openFiles
        .filter((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
        .map((file) => file.id)
    ),
    new Set((store.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).map((tab) => tab.id))
  )
  return visibleTabs.flatMap((tab) => (tab.tabId ? [tab.tabId] : []))
}

export function moveFloatingWorkspaceTab(
  store: FloatingWorkspaceTabReorderStore,
  direction: -1 | 1
): boolean {
  const group = getActiveFloatingWorkspaceGroup(store)
  if (!group?.activeTabId) {
    return false
  }
  const nextOrder = moveTabIdWithinGroupOrder(
    group.tabOrder,
    getFloatingWorkspaceVisibleTabIds(store, group),
    group.activeTabId,
    direction
  )
  if (!nextOrder) {
    return false
  }
  store.reorderUnifiedTabs(group.id, nextOrder)
  mirrorWebRuntimeTabMove({
    kind: 'reorder',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    tabId: group.activeTabId,
    targetGroupId: group.id,
    tabOrder: nextOrder
  })
  return true
}
