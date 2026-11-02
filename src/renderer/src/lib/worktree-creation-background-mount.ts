import { useAppStore } from '@/store'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'

/** Mount startup-owing tabs without activating: hidden workspaces otherwise never run renderer agent/setup/issue startup despite announcing readiness. */
export function mountCreatedWorktreeStartupTabsInBackground(worktreeId: string): void {
  const state = useAppStore.getState()
  const tabIds = (state.tabsByWorktree[worktreeId] ?? [])
    .map((tab) => tab.id)
    .filter(
      (tabId) =>
        state.pendingStartupByTabId[tabId] !== undefined ||
        state.pendingIssueCommandSplitByTabId[tabId] !== undefined
    )
  if (tabIds.length > 0) {
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds })
  }
}
