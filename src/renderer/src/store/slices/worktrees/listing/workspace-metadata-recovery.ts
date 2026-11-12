import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { WorktreeFetchOptions } from './worktree-fetch-options'

type FetchWorktrees = (repoId: string, options: WorktreeFetchOptions) => Promise<unknown>

// One recovery listing per repo and host at a time; a request during one runs once more after it.
const inFlight = new Set<string>()
const rerun = new Set<string>()

/**
 * Lists a repo afresh (never joining a listing that may predate a published metadata write). The
 * listing's own coverage check asks again if it still turns out stale.
 */
export function requestWorkspaceMetadataRecovery(
  repoId: string,
  hostId: ExecutionHostId,
  fetchWorktrees: FetchWorktrees
): void {
  const key = `${hostId}\u0000${repoId}`
  if (inFlight.has(key)) {
    rerun.add(key)
    return
  }
  inFlight.add(key)
  const options: WorktreeFetchOptions =
    hostId === LOCAL_EXECUTION_HOST_ID
      ? { forceLocalOwner: true, forceFresh: true, suppressRemoteLineageRefresh: true }
      : { executionHostId: hostId, forceFresh: true, suppressRemoteLineageRefresh: true }
  void fetchWorktrees(repoId, options)
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(key)
      if (rerun.delete(key)) {
        requestWorkspaceMetadataRecovery(repoId, hostId, fetchWorktrees)
      }
    })
}
