import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'

/** Preserved branches carry owner host so later force-delete targets the right multi-host repo. */
export type RendererRemoveWorktreeResult = Omit<RemoveWorktreeResult, 'preservedBranch'> & {
  preservedBranch?: NonNullable<RemoveWorktreeResult['preservedBranch']> & {
    hostId?: ExecutionHostId
    runtimeEnvironmentId?: string
  }
}
