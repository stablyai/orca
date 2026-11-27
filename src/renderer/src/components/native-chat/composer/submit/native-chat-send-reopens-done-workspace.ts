import { useAppStore } from '@/store'
import { selectWorkspaceStatusesForHost } from '@/store/workspaces/status/host-workspace-status-columns'
import { workspaceStatusAfterChatSend } from '../../../../../../shared/workspace/status/workspace-status-reopen-on-send'
import { findNativeChatTabOwnerWorktreeId } from '../../pane/ownership/native-chat-tab-owner'

/** Sending a message in a Done workspace resumes work there, so its card moves back to In progress. */
export function reopenDoneWorkspaceOnChatSend(owner: {
  worktreeId?: string | null
  terminalTabId?: string
}): void {
  const state = useAppStore.getState()
  const worktreeId =
    owner.worktreeId ??
    (owner.terminalTabId ? findNativeChatTabOwnerWorktreeId(state, owner.terminalTabId) : null)
  const worktree = worktreeId ? state.getKnownWorktreeById(worktreeId) : undefined
  if (!worktree || !('workspaceStatus' in worktree)) {
    return
  }
  const next = workspaceStatusAfterChatSend(
    worktree,
    selectWorkspaceStatusesForHost(state, worktree)
  )
  if (!next) {
    return
  }
  void state.updateWorktreeMeta(
    worktree.id,
    { workspaceStatus: next },
    { executionHostId: worktree.hostId ?? 'local' }
  )
}
