import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeForceDeleteReason } from '../../../../shared/worktree/removal'
import type { Worktree } from '../../../../shared/worktree/types'

export type WorktreeDeleteState = {
  isDeleting: boolean
  phase?: 'deleting' | 'queued'
  executionHostId?: ExecutionHostId | null
  error: string | null
  canForceDelete: boolean
  forceDeleteReason: WorktreeForceDeleteReason | null
  lockReason?: string | null
}

export type WorktreeDeleteStateTarget = Pick<Worktree, 'id' | 'hostId'>
