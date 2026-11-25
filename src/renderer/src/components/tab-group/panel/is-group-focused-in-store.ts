import { resolveFloatingWorkspaceSurfaceModel } from '@/components/floating-terminal/workspace/floating-workspace-surface-model'
import { selectFloatingWorkspacePanelVisible } from '@/store/workspaces/floating/floating-workspace-panel-selector'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import { useAppStore } from '../../../store'

/** Read at execution from the store, so a deferred focus handback never trusts a stale render. */
export function isGroupFocusedInStore(worktreeId: string, groupId: string): boolean {
  const state = useAppStore.getState()
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    if (!selectFloatingWorkspacePanelVisible(state)) {
      return false
    }
    const current = resolveFloatingWorkspaceSurfaceModel(state)
    return current.kind === 'workspace' && current.focusedGroupId === groupId
  }
  return (
    state.activeWorktreeId === worktreeId && state.activeGroupIdByWorktree[worktreeId] === groupId
  )
}
