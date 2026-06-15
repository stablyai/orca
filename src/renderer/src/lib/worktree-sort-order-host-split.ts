import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'

export type WorktreeSortOrderHostGroup = {
  hostId: string
  orderedIds: string[]
}

/** Split a worktree sort order into per-owner-host groups (preserving relative
 *  order within each host).
 *
 *  Why: persisted `sortOrder` lives in each host's `worktreeMeta` and is enriched
 *  onto worktrees from their owner host. Stamping the full cross-host id list on
 *  only the focused host loses other hosts' ordering and pollutes the focused
 *  host with foreign ids, so persist each host's ids on that host.
 */
export function splitWorktreeSortOrderByHost(
  state: WorktreeRuntimeOwnerState,
  orderedIds: readonly string[]
): WorktreeSortOrderHostGroup[] {
  const groups = new Map<string, string[]>()
  for (const id of orderedIds) {
    const environmentId = getRuntimeEnvironmentIdForWorktree(state, id)
    const hostId = environmentId ? toRuntimeExecutionHostId(environmentId) : LOCAL_EXECUTION_HOST_ID
    const existing = groups.get(hostId)
    if (existing) {
      existing.push(id)
    } else {
      groups.set(hostId, [id])
    }
  }
  return [...groups.entries()].map(([hostId, ids]) => ({ hostId, orderedIds: ids }))
}
