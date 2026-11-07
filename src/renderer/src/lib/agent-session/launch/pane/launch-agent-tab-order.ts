import { useAppStore } from '@/store/index'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { workspaceEditorFiles } from '@/store/slices/editor/tabs/workspace-editor-files'

export function persistAgentLaunchTabOrder(worktreeId: string, tabId: string): void {
  const store = useAppStore.getState()
  const terminalIds = (store.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = workspaceEditorFiles(
    store.openFiles,
    store.unifiedTabsByWorktree[worktreeId]
  ).map((file) => file.id)
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
