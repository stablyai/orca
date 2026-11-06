import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { resolveOwnerOrLocal } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import {
  resolveWorktreeOperationRouteResultForHost,
  type WorktreeOperationRouteState
} from './worktree-operation-route'
import { routeForOwner } from './worktree-owner-route'
import { getLocalPathOpenOwnerForRoute } from './local-path-open-guard'

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
    // Why: a twin names no owner, and Open in must not launch it as this desktop's checkout.
    const owner = resolveOwnerOrLocal(state, { workspaceId: worktree.id })
    if (owner.kind === 'ambiguous') {
      return UNRESOLVED
    }
    // Why: an owner no row places was read as this desktop before the fold, and still is.
    if (owner.kind === 'missing') {
      return resolved(null)
    }
    const { endpoint, at } = owner.owner
    return resolved(endpoint.kind === 'environment' ? endpoint.environmentId : null, at)
  }
  // Why: an inactive row can name its host before the catalog has it, so the explicit host wins.
  const resolution = resolveWorktreeOperationRouteResultForHost(state, worktree.id, worktree.hostId)
  return resolution.kind === 'resolved'
    ? resolved(
        resolution.route.runtimeEnvironmentId,
        resolution.route.executionHostId ?? worktree.hostId
      )
    : UNRESOLVED
}

/** The same owner as a local-path guard owner, for row actions beside Open in such as Copy Path. */
export function getWorktreeRowLocalPathOpenOwner(
  state: WorktreeOperationRouteState & WorktreeRuntimeOwnerState,
  worktree: Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>,
  repoConnectionId: string | null | undefined
): ExecutionHostId | 'unresolved' {
  const owner = resolveWorktreeRowOpenInRuntimeOwner(state, worktree)
  return getLocalPathOpenOwnerForRoute({
    ...owner,
    connectionId: owner.connectionId ?? repoConnectionId
  })
}
