import { useAppStore } from '../store'
import {
  insertTabIdIntoOrder,
  partitionPinnedTabOrder
} from '../../../shared/workspace-layout/tab-order'

/** Move `tabId` to sit immediately after `anchorTabId` (null: first after pinned tabs); no-op unless both share a live group. */
export function insertUnifiedTabAfterAnchor(
  worktreeId: string,
  tabId: string,
  anchorTabId: string | null
): void {
  if (tabId === anchorTabId) {
    return
  }
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tab = tabs.find((candidate) => candidate.id === tabId)
  const anchor =
    anchorTabId === null ? null : tabs.find((candidate) => candidate.id === anchorTabId)
  if (!tab || anchor === undefined || (anchor && tab.groupId !== anchor.groupId)) {
    return
  }
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tab.groupId
  )
  if (!group?.tabOrder.includes(tabId) || (anchorTabId && !group.tabOrder.includes(anchorTabId))) {
    return
  }
  const order =
    anchorTabId === null
      ? partitionPinnedTabOrder(group.tabOrder, tabs, tabId)
      : insertTabIdIntoOrder(group.tabOrder, tabs, tabId, tab.isPinned === true, anchorTabId)
  if (
    order.length === group.tabOrder.length &&
    order.every((id, index) => id === group.tabOrder[index])
  ) {
    return
  }
  state.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
}

/** Place a terminal tab a reveal just created after `anchor` (a unified or entity id; null: first). */
export function placeCreatedTerminalTab(
  worktreeId: string,
  terminalTabId: string,
  anchor: string | null
): void {
  const unifiedTabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
  const created = unifiedTabs.find((item) => item.entityId === terminalTabId)?.id
  const anchorUnified =
    anchor === null
      ? null
      : unifiedTabs.find((item) => item.id === anchor || item.entityId === anchor)?.id
  if (created && anchorUnified !== undefined) {
    insertUnifiedTabAfterAnchor(worktreeId, created, anchorUnified)
  }
}
