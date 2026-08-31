import type { RemoveWorktreeOptions } from '@/store/slices/worktree-removal-options'
import type { RendererRemoveWorktreeResult } from '@/store/slices/renderer-remove-worktree-result'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { prepareActiveWorktreeFocusAfterDelete } from '../sidebar/active-worktree-focus-after-delete'
import { settleForceDeleteRetry } from '../sidebar/force-delete-retry-toast'

type RemoveWorktree = (
  target: WorktreeRemovalTarget,
  force?: boolean,
  options?: RemoveWorktreeOptions
) => Promise<({ ok: true } & RendererRemoveWorktreeResult) | { ok: false; error: string }>

/**
 * The Space Manager's explicit "Force Delete" recovery for a row whose delete failed.
 *
 * Why: Space keeps normal deletes non-force so uncommitted work is not discarded silently;
 * a failed row gets this explicit recovery path.
 */
export function runWorkspaceSpaceForceDelete(args: {
  worktree: Pick<WorkspaceSpaceWorktree, 'worktreeId' | 'executionHostId' | 'displayName'>
  removeWorktree: RemoveWorktree
  onDeleted: (target: WorktreeRemovalTarget) => void
}): void {
  const { worktree, removeWorktree, onDeleted } = args
  const target: WorktreeRemovalTarget = {
    id: worktree.worktreeId,
    executionHostId: worktree.executionHostId ?? null
  }
  const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktree.worktreeId)
  // Why (#11960): explicit force recovery, so it may also waive PTY-stop proof.
  // Why the host (STA-4343): the Space scan lists one row per host, so a bare
  // id would let this force delete another host's checkout at the same path.
  void settleForceDeleteRetry(removeWorktree(target, true, { allowUnverifiedPtyStop: true }), {
    worktreeName: worktree.displayName,
    onDeleted: () => {
      commitFocus()
      onDeleted(target)
    }
  })
}
