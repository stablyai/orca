import { requestTerminalTabRenameWhenMounted } from '@/components/tab-bar/terminal-tabs/terminal-tab-rename-request'
import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '../components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { activateAndRevealWorkspace } from './workspace/activation/worktree-activation'

/** Reveals a tab launched from Chat UI before opening its inline name editor. */
export function activateNativeChatAgentLaunchTab(tabId: string): void {
  const initial = useAppStore.getState()
  const tab = initial.getTab(tabId)
  if (!tab) {
    return
  }
  if (initial.activeWorktreeId !== tab.worktreeId) {
    const activated = activateAndRevealWorkspace(tab.worktreeId, {
      providesInitialSurface: true,
      revealInSidebar: false,
      clearSidebarFilters: false,
      ...(tab.executionHostId ? { executionHostId: tab.executionHostId } : {})
    })
    if (activated === false) {
      return
    }
  }
  const state = useAppStore.getState()
  state.focusGroup(tab.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: tab.worktreeId })
  if (tab.contentType === 'agent-session') {
    state.setActiveTabType('agent-session', tab.worktreeId)
  } else if (tab.contentType === 'terminal') {
    state.setActiveTabType('terminal', tab.worktreeId)
    focusTerminalTabSurface(tab.entityId)
  } else {
    return
  }
  requestTerminalTabRenameWhenMounted(tab.id)
}
