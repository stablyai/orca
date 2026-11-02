import { useAppStore } from '@/store'
import { findWslMovedProjectForWorkspace } from '@/store/repos/wsl-moved-projects'
import { activateStructuredAgentSessionTab } from './agent-session/structured-agent-session-tab-activation'

/**
 * Opens a workspace of a project a WSL host now owns, for its chats only. Unlike a normal
 * activation it seeds no terminal and wakes no sleeping agent: those belong to the host now.
 * False when the workspace is not a moved one, so callers fall through to the normal activation.
 */
export function activateWslMovedWorkspace(workspaceKey: string, chatTabId?: string): boolean {
  const state = useAppStore.getState()
  if (!findWslMovedProjectForWorkspace(state, workspaceKey)) {
    return false
  }
  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }
  if (state.activeWorktreeId !== workspaceKey) {
    state.setActiveWorktree(workspaceKey)
  }
  if (chatTabId) {
    activateStructuredAgentSessionTab({ worktreeId: workspaceKey, tabId: chatTabId })
  }
  return true
}
