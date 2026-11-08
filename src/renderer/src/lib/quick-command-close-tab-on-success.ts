import { useAppStore } from '@/store'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import { collectLeafIds } from '../../../shared/workspace-layout/terminal-pane-layout-tree'

// tabId → worktreeId of Quick Command tabs waiting for their startup command to finish.
const armedTabs = new Map<string, string>()

function tabExists(tabId: string, worktreeId: string): boolean {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

function handleCommandFinished(event: Event): void {
  const { tabId, exitCode } = (event as CustomEvent<TerminalCommandFinishedEventDetail>).detail
  for (const [armedTabId, worktreeId] of armedTabs) {
    if (!tabExists(armedTabId, worktreeId)) {
      armedTabs.delete(armedTabId)
    }
  }
  // Only the startup command's own exit decides; later commands typed into the tab never close it.
  if (tabId && armedTabs.delete(tabId)) {
    const state = useAppStore.getState()
    // A split means the user adopted the tab for other work; closing would kill those panes too.
    const paneCount = collectLeafIds(state.terminalLayoutsByTabId[tabId]?.root).length
    if (exitCode === 0 && paneCount <= 1) {
      state.closeTab(tabId, { recordInteraction: false })
    }
  }
  if (armedTabs.size === 0) {
    window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
  }
}

/** Close a Quick Command's tab once its startup command exits 0 (OSC 133;D); failures and unknown exits stay open. */
export function closeQuickCommandTabOnSuccess(tabId: string, worktreeId: string): void {
  if (armedTabs.size === 0) {
    window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
  }
  armedTabs.set(tabId, worktreeId)
}
