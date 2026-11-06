import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

export function persistAgentLaunchTabOrder(worktreeId: string, tabId: string): void {
  const store = useAppStore.getState()
  const terminalIds = (store.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = (store.unifiedTabsByWorktree[worktreeId] ?? [])
    .filter((tab) => isEditorTabContentType(tab.contentType))
    .map((tab) => tab.id)
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
