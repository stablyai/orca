import { useAppStore } from '@/store'
import { selectWorkspaceStatusesForHost } from '@/store/workspaces/status/host-workspace-status-columns'
import { getWorkspaceStatus } from '../../../../../../shared/workspace/status/workspace-statuses'
import { findNativeChatTabOwnerWorktreeId } from '../../pane/ownership/native-chat-tab-owner'

const DONE_STATUS_ID = 'completed'
const IN_PROGRESS_STATUS_ID = 'in-progress'

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
  const statuses = selectWorkspaceStatusesForHost(state, worktree)
  if (
    getWorkspaceStatus(worktree, statuses) !== DONE_STATUS_ID ||
    !statuses.some((status) => status.id === IN_PROGRESS_STATUS_ID)
  ) {
    return
  }
  void state.updateWorktreeMeta(
    worktree.id,
    { workspaceStatus: IN_PROGRESS_STATUS_ID },
    { executionHostId: worktree.hostId ?? 'local' }
  )
}
