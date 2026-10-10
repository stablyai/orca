import { parseExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import {
  resolveStrictWorktreeOperationRouteResultForHost,
  type WorktreeOperationRouteState
} from './worktree-operation-route'
import { routeForOwner } from './worktree-owner-route'

export type WorktreeRowOpenInOwner = {
  runtimeEnvironmentId: string | null
  /** SSH target the row lives on; a folder or host-only SSH row has no repo connection to say so. */
  connectionId: string | null
  /** The store cannot place the row; a null runtime then must not read as desktop ownership. */
  ownerUnresolved: boolean
}

const UNRESOLVED: WorktreeRowOpenInOwner = {
  runtimeEnvironmentId: null,
  connectionId: null,
  ownerUnresolved: true
}

function resolved(
  runtimeEnvironmentId: string | null,
  hostId?: string | null
): WorktreeRowOpenInOwner {
  const host = runtimeEnvironmentId ? null : parseExecutionHostId(hostId)
  return {
    runtimeEnvironmentId,
    connectionId: host?.kind === 'ssh' ? host.targetId : null,
    ownerUnresolved: false
  }
}

/** Runtime that owns one clicked sidebar row, for the desktop Open in launch guards. */
export function resolveWorktreeRowOpenInRuntimeOwner(
  state: WorktreeOperationRouteState & WorktreeRuntimeOwnerState,
  worktree: Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>
): WorktreeRowOpenInOwner {
  // Why: the row's stamped owner is exact; rival HUBs can share its host id, so never re-derive it.
  if (worktree.runtimeOwnerEnvironmentId?.trim()) {
    const runtimeEnvironmentId = routeForOwner(worktree)?.runtimeEnvironmentId
    return runtimeEnvironmentId ? resolved(runtimeEnvironmentId) : UNRESOLVED
  }
  if (!worktree.hostId) {
    return resolved(
      getRuntimeEnvironmentIdForWorktree(state, worktree.id),
      getResolvedExecutionHostIdForWorktree(state, worktree.id)
    )
  }
  // Why: an inactive row can name its host before the catalog has it, so the explicit host wins.
  const resolution = resolveStrictWorktreeOperationRouteResultForHost(
    state,
    worktree.id,
    worktree.hostId
  )
  return resolution.kind === 'resolved'
    ? resolved(
        resolution.route.runtimeEnvironmentId,
        resolution.route.executionHostId ?? worktree.hostId
      )
    : UNRESOLVED
}
