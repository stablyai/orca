import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'

/**
 * What `removeWorktree` resolves with in the renderer.
 *
 * Widens main's result: a preserved branch has to name the host it was preserved
 * on, or the follow-up force-delete cannot find it again on a multi-host repo.
 */
export type RendererRemoveWorktreeResult = Omit<RemoveWorktreeResult, 'preservedBranch'> & {
  preservedBranch?: NonNullable<RemoveWorktreeResult['preservedBranch']> & {
    hostId?: ExecutionHostId
    runtimeEnvironmentId?: string
  }
}
