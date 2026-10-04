import { useAppStore } from '@/store'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'

/**
 * Mounts, without opening the workspace, the created terminal tabs that still owe startup work.
 * Why: an unopened workspace never mounts its panes, so a renderer-owned agent, setup script or
 * issue command would wait until the user opened it while the ready toast already announced it.
 */
export function mountCreatedWorktreeStartupTabsInBackground(worktreeId: string): void {
  const state = useAppStore.getState()
  const tabIds = (state.tabsByWorktree[worktreeId] ?? [])
    .map((tab) => tab.id)
    .filter(
      (tabId) =>
        state.pendingStartupByTabId[tabId] !== undefined ||
        state.pendingSetupSplitByTabId[tabId] !== undefined ||
        state.pendingIssueCommandSplitByTabId[tabId] !== undefined
    )
  if (tabIds.length > 0) {
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds })
  }
}
