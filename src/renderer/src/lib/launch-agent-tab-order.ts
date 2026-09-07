import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'

/** Keep a newly-created agent tab at the end of the tab-bar order. */
export function persistAgentLaunchTabOrder(worktreeId: string, tabId: string): void {
  const store = useAppStore.getState()
  const terminalIds = (store.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = store.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((file) => file.id)
  const browserIds = (store.browserTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
  const order = reconcileTabOrder(
    store.tabBarOrderByWorktree[worktreeId],
    terminalIds,
    editorIds,
    browserIds
  ).filter((id) => id !== tabId)
  order.push(tabId)
  store.setTabBarOrder(worktreeId, order)
}
