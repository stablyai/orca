import { useAppStore } from '../store'
import { insertTabIdIntoOrder } from '../store/slices/tabs/tabs-tab-order'

/** Move `tabId` to sit immediately after `anchorTabId`; no-op unless both share a live group. */
export function insertUnifiedTabAfterAnchor(
  worktreeId: string,
  tabId: string,
  anchorTabId: string
): void {
  if (tabId === anchorTabId) {
    return
  }
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tab = tabs.find((candidate) => candidate.id === tabId)
  const anchor = tabs.find((candidate) => candidate.id === anchorTabId)
  if (!tab || !anchor || tab.groupId !== anchor.groupId) {
    return
  }
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tab.groupId
  )
  if (!group?.tabOrder.includes(tabId) || !group.tabOrder.includes(anchorTabId)) {
    return
  }
  const order = insertTabIdIntoOrder(
    group.tabOrder,
    tabs,
    tabId,
    tab.isPinned === true,
    anchorTabId
  )
  if (
    order.length === group.tabOrder.length &&
    order.every((id, index) => id === group.tabOrder[index])
  ) {
    return
  }
  state.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
}
