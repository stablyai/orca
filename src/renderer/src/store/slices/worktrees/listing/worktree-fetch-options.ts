import type { ExecutionHostId } from '../../../../../../shared/execution-host'

import type { SshExecutionHostId } from '../../../../../../shared/detected-worktree-provider-contract'
import type { DirectSshAuthority } from '../../../../../../shared/ssh-types'

export type WorktreeFetchOptions = {
  requireAuthoritative?: boolean
  executionHostId?: ExecutionHostId
  forceLocalOwner?: boolean
  /** Skip automatic remote lineage when the caller owns a final host-wide refresh. */
  suppressRemoteLineageRefresh?: boolean
  /** Start a new listing instead of joining one in flight (it may predate a published metadata write). */
  forceFresh?: boolean
}

export type DirectSshWorktreeFetchOptions = WorktreeFetchOptions & {
  executionHostId: SshExecutionHostId
  directSshAuthority: DirectSshAuthority
}
