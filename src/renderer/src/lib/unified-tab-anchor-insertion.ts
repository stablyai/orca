import { useAppStore } from '../store'

/** Move `tabId` to sit immediately after `anchorTabId`; no-op unless both share a group. */
export function insertUnifiedTabAfterAnchor(
  worktreeId: string,
  tabId: string,
  anchorTabId: string
): void {
  if (tabId === anchorTabId) {
    return
  }
  const state = useAppStore.getState()
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.tabOrder.includes(tabId) && candidate.tabOrder.includes(anchorTabId)
  )
  if (!group) {
    return
  }
  const order = group.tabOrder.filter((id) => id !== tabId)
  order.splice(order.indexOf(anchorTabId) + 1, 0, tabId)
  state.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
}
