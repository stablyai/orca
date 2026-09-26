import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { isTerminalLeafId } from '../../../../../../shared/stable-pane-id'

/** Enter in the workspace list: hand focus to the active workspace's terminal pane. */
export function focusActiveWorkspaceTerminal(): void {
  const { activeTabId, activeTabType, activeWorktreeId, tabsByWorktree, terminalLayoutsByTabId } =
    useAppStore.getState()
  const ownsTab =
    activeWorktreeId !== null &&
    tabsByWorktree[activeWorktreeId]?.some((tab) => tab.id === activeTabId) === true
  if (activeTabType === 'terminal' && activeTabId && ownsTab) {
    const leafId = terminalLayoutsByTabId[activeTabId]?.activeLeafId
    // Why: the first .xterm in the DOM can be another workspace's hidden terminal (#22903).
    focusTerminalTabSurface(activeTabId, leafId && isTerminalLeafId(leafId) ? leafId : null)
    return
  }
  document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
}
