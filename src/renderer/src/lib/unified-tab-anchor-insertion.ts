import { closeMobileSessionTabInStore } from '@/runtime/mobile-session-tab-close'
import { useAppStore } from '../store'
import { insertTabIdIntoOrder } from '../../../shared/workspace-layout/tab-order'

/** Move `tabId` to sit immediately after `anchorTabId`; no-op unless both share a live group. */
export function findUnifiedTab(worktreeId: string, tabId: string) {
  return (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId || candidate.entityId === tabId
  )
}

/** A same-slot switch's window write: the new tab takes the replaced tab's index, then the replaced tab closes. */
export function replaceUnifiedTab(worktreeId: string, tabId: string, replacedTabId: string): void {
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tab = tabs.find((candidate) => candidate.id === tabId || candidate.entityId === tabId)
  const replaced = tabs.find((candidate) => candidate.id === replacedTabId)
  const group = (state.groupsByWorktree[worktreeId] ?? []).find((candidate) =>
    candidate.tabOrder.includes(replacedTabId)
  )
  if (!tab || !replaced || !group || tab.id === replaced.id) {
    return
  }
  const order = group.tabOrder.filter((id) => id !== tab.id)
  order.splice(order.indexOf(replaced.id), 0, tab.id)
  if (group.tabOrder.includes(tab.id)) {
    state.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
  }
  closeMobileSessionTabInStore(useAppStore.getState(), worktreeId, replaced.id)
}

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

/** Where a main-created terminal tab goes: into a replaced tab's slot, else after its anchor. */
export function placeCreatedTerminalTab(
  worktreeId: string,
  tabId: string,
  placement: { afterTabId?: string; replaced?: { id: string } }
): void {
  if (placement.replaced) {
    replaceUnifiedTab(worktreeId, tabId, placement.replaced.id)
    return
  }
  const created = findUnifiedTab(worktreeId, tabId)
  const anchor = placement.afterTabId && findUnifiedTab(worktreeId, placement.afterTabId)
  if (created && anchor) {
    insertUnifiedTabAfterAnchor(worktreeId, created.id, anchor.id)
  }
}
