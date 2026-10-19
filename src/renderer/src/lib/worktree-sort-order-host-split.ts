import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { isUnprovenServerSshRoute } from './resolve-owner'
import { resolveOwnerWithLegacyFallback } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

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
 *  host with foreign ids, so persist each host's ids on that host. Ids no host can be
 *  proven to own are left out.
 */
export function splitWorktreeSortOrderByHost(
  state: WorktreeRuntimeOwnerState,
  orderedIds: readonly string[]
): WorktreeSortOrderHostGroup[] {
  const groups = new Map<string, string[]>()
  for (const id of orderedIds) {
    const owner = resolveOwnerWithLegacyFallback(state, { workspaceId: id })
    // Why: a twin names no host to write to, and an unproven server route may be another machine.
    if (owner.kind !== 'resolved' || isUnprovenServerSshRoute(state, id, owner.owner)) {
      continue
    }
    const { endpoint } = owner.owner
    const hostId =
      endpoint.kind === 'environment'
        ? toRuntimeExecutionHostId(endpoint.environmentId)
        : LOCAL_EXECUTION_HOST_ID
    const existing = groups.get(hostId)
    if (existing) {
      existing.push(id)
    } else {
      groups.set(hostId, [id])
    }
  }
  return [...groups.entries()].map(([hostId, ids]) => ({ hostId, orderedIds: ids }))
}
