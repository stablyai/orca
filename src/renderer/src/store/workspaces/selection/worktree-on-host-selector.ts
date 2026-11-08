import type { Worktree } from '../../../../../shared/worktree/types'
import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getIndexedWorktreesById as getCachedWorktreesById } from '../../slices/worktrees/listing/worktree-catalog-index'
import { selectWorktreesByRepo } from '../catalog/workspace-record-fields'
import { worktreeCopyOwnerKey } from '../../slices/worktrees/metadata/worktree-copy-review-clear'
import { findSoleHostCopy } from '../../../../../shared/worktree/host-qualified-identity'

/**
 * The one copy of `worktreeId` on `hostId` (STA-4343). Ids repeat across hosts, so a lookup that
 * still matches two copies answers undefined instead of first-wins; callers refuse rather than guess.
 */
export function getWorktreeOnHostFromState(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string,
  hostId: ExecutionHostId | undefined
): Worktree | undefined {
  const rows = getCachedWorktreesById(selectWorktreesByRepo(state), worktreeId)
  return findSoleHostCopy(
    hostId ? rows.filter((row) => row.hostId === hostId) : rows,
    worktreeCopyOwnerKey
  )
}
