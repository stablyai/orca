import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import type {
  WorkspaceMultiplexerSlot,
  WorkspaceMultiplexerState
} from '../../../../shared/workspace-multiplexer-types'
import { removeWorkspaceMultiplexerSlot } from './workspace-multiplexer-layout'

export function deleteMultiplexerWorktree(slot: WorkspaceMultiplexerSlot): void {
  const hostId = slot.executionHostId ?? 'local'
  const worktree = getWorktreeOnHostFromState(useAppStore.getState(), slot.worktreeId, hostId)
  if (!worktree || worktree.isMainWorktree) {
    return
  }
  runWorktreeDelete(worktree.id, {
    expectedHostId: hostId,
    expectedInstanceId: worktree.instanceId,
    forceConfirm: true,
    onDeleted: (targets) => {
      const state = useAppStore.getState()
      const removeDeleted = (layout: WorkspaceMultiplexerState): WorkspaceMultiplexerState =>
        layout.slots.reduce(
          (next, candidate) =>
            targets.some(
              (target) =>
                target.id === candidate.worktreeId &&
                (target.executionHostId ?? 'local') === (candidate.executionHostId ?? 'local')
            )
              ? removeWorkspaceMultiplexerSlot(next, candidate.id)
              : next,
          layout
        )
      state.setWorkspaceMultiplexer({
        ...removeDeleted(state.workspaceMultiplexer),
        ...(state.workspaceMultiplexer.savedLayouts
          ? {
              savedLayouts: state.workspaceMultiplexer.savedLayouts.map((saved) => ({
                ...saved,
                layout: removeDeleted(saved.layout)
              }))
            }
          : {})
      })
    }
  })
}
