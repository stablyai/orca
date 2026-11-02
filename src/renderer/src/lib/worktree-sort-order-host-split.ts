import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { isUnprovenServerSshRoute } from './resolve-owner'
import { resolveOwnerOrLocal } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

export type WorktreeSortOrderHostGroup = {
  hostId: string
  orderedIds: string[]
  /** Parallel to `orderedIds`: each copy's host as its endpoint stamps it, so twins stay apart. */
  rowHostIds: string[]
}

/** Persist each host’s IDs in its own worktreeMeta, preserving within-host order. Writing all IDs only to focused host loses other owners’ order and pollutes that host; omit unproven owners. */
export function splitWorktreeSortOrderByHost(
  state: WorktreeRuntimeOwnerState,
  orderedIds: readonly string[]
): WorktreeSortOrderHostGroup[] {
  const groups = new Map<string, { orderedIds: string[]; rowHostIds: string[] }>()
  for (const id of orderedIds) {
    const owner = resolveOwnerOrLocal(state, { workspaceId: id })
    // Why: a twin names no host to write to, and an unproven server route may be another machine.
    if (owner.kind !== 'resolved' || isUnprovenServerSshRoute(state, id, owner.owner)) {
      continue
    }
    const { endpoint, at } = owner.owner
    const hostId =
      endpoint.kind === 'environment'
        ? toRuntimeExecutionHostId(endpoint.environmentId)
        : LOCAL_EXECUTION_HOST_ID
    const group = groups.get(hostId) ?? { orderedIds: [], rowHostIds: [] }
    group.orderedIds.push(id)
    group.rowHostIds.push(at)
    groups.set(hostId, group)
  }
  return [...groups.entries()].map(([hostId, group]) => ({ hostId, ...group }))
}
