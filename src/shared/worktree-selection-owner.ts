import type { ExecutionHostId } from './execution-host'
import type { WorktreeIdentityRef } from './worktree/identity'

export type WorktreeSelectionOwner = Pick<WorktreeIdentityRef, 'worktreeId' | 'executionHostId'> & {
  publisherHostId: ExecutionHostId
  instanceId?: string
}
