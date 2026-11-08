import { useAppStore } from '@/store'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { collectLeafIds } from '../../../shared/workspace-layout/terminal-pane-layout-tree'
import { rootShellActivity } from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

// tabId → worktreeId of Quick Command tabs waiting for their startup command to finish.
const armedTabs = new Map<string, string>()

function tabExists(tabId: string, worktreeId: string): boolean {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

function disarm(tabId: string): void {
  armedTabs.delete(tabId)
  if (armedTabs.size === 0) {
    window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
  }
}

async function settleArmedTab(tabId: string, exitCode: number | null): Promise<void> {
  const state = useAppStore.getState()
  const ptyId = state.ptyIdsByTabId[tabId]?.[0]
  // A split means the user adopted the tab for other work; closing would kill those panes too.
  const paneCount = collectLeafIds(state.terminalLayoutsByTabId[tabId]?.root).length
  if (!ptyId || paneCount > 1) {
    disarm(tabId)
    return
  }
  // 133;D can come from a nested shell or the command's own output; only the root shell's prompt proves it exited.
  const activity = await inspectRuntimeTerminalProcess(ptyId, { scanChildProcesses: true })
    .then(rootShellActivity)
    .catch(() => 'unknown' as const)
  const worktreeId = armedTabs.get(tabId)
  if (worktreeId === undefined || activity === 'busy') {
    return
  }
  disarm(tabId)
  if (exitCode === 0 && activity === 'idle' && tabExists(tabId, worktreeId)) {
    useAppStore.getState().closeTab(tabId, { recordInteraction: false })
  }
}

function handleCommandFinished(event: Event): void {
  if (!(event instanceof CustomEvent)) {
    return
  }
  const { tabId, exitCode }: TerminalCommandFinishedEventDetail = event.detail
  for (const [armedTabId, worktreeId] of armedTabs) {
    if (!tabExists(armedTabId, worktreeId)) {
      disarm(armedTabId)
    }
  }
  if (tabId && armedTabs.has(tabId)) {
    void settleArmedTab(tabId, exitCode)
  }
}

/** Close a Quick Command's tab once its command exits 0 and the root shell is idle again; failures and unproven exits stay open. */
export function closeQuickCommandTabOnSuccess(tabId: string, worktreeId: string): void {
  if (armedTabs.size === 0) {
    window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
  }
  armedTabs.set(tabId, worktreeId)
}
