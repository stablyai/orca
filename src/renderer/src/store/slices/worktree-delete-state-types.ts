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
  /** The removal was refused by a failed archive hook, so "Delete anyway" is offered (#19334). */
  canWaiveArchiveHook?: boolean
}

export type WorktreeDeleteStateTarget = Pick<Worktree, 'id' | 'hostId'>
