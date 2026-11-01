import { useAppStore } from '../store'
import { insertTabIdIntoOrder } from '../../../shared/workspace-layout/tab-order'

/** Move `tabId` to sit immediately after `anchorTabId`; no-op unless both share a live group. */
export function findUnifiedTab(worktreeId: string, tabId: string) {
  return (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId || candidate.entityId === tabId
  )
}

/**
 * A same-slot switch's window write: the new tab takes the replaced tab's index and pin, then the
 * replaced tab closes as layout only; its host already stopped what it showed. Returns whether
 * the replaced tab closed.
 */
export function replaceUnifiedTab(
  worktreeId: string,
  tabId: string,
  replacedTabId: string
): boolean {
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tab = tabs.find((candidate) => candidate.id === tabId || candidate.entityId === tabId)
  const replaced = tabs.find((candidate) => candidate.id === replacedTabId)
  const group = (state.groupsByWorktree[worktreeId] ?? []).find((candidate) =>
    candidate.tabOrder.includes(replacedTabId)
  )
  if (!tab || !replaced || !group || tab.id === replaced.id) {
    return false
  }
  takeReplacedTabSlot(worktreeId, tab, replaced)
  return (
    useAppStore
      .getState()
      .closeUnifiedTab(replaced.id, { replaced: true, recordInteraction: false }) !== null
  )
}

/**
 * The new tab takes the replaced tab's pin, then its index. Pinning moves a tab to the end of the
 * pinned group, so it comes first, or a slot in the middle of that group would be lost.
 */
export function takeReplacedTabSlot(
  worktreeId: string,
  tab: { id: string; isPinned?: boolean },
  replaced: { id: string; isPinned?: boolean }
): void {
  if (replaced.isPinned && !tab.isPinned) {
    useAppStore.getState().pinTab(tab.id, { recordInteraction: false })
  }
  const state = useAppStore.getState()
  const group = (state.groupsByWorktree[worktreeId] ?? []).find((candidate) =>
    candidate.tabOrder.includes(replaced.id)
  )
  if (!group?.tabOrder.includes(tab.id)) {
    return
  }
  const order = group.tabOrder.filter((id) => id !== tab.id)
  order.splice(order.indexOf(replaced.id), 0, tab.id)
  if (order.some((id, index) => id !== group.tabOrder[index])) {
    state.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
  }
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

/** Where a main-created terminal tab goes: into a replaced tab's slot, else after its anchor.
 *  Returns whether a replaced tab closed. */
export function placeCreatedTerminalTab(
  worktreeId: string,
  tabId: string,
  placement: { afterTabId?: string; replaced?: { id: string } }
): boolean {
  if (placement.replaced) {
    return replaceUnifiedTab(worktreeId, tabId, placement.replaced.id)
  }
  if (!placement.afterTabId) {
    return false
  }
  const created = findUnifiedTab(worktreeId, tabId)
  const anchor = findUnifiedTab(worktreeId, placement.afterTabId)
  if (created && anchor) {
    insertUnifiedTabAfterAnchor(worktreeId, created.id, anchor.id)
  }
  return false
}
