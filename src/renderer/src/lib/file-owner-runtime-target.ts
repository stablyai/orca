import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeTargetForWorkspaceOwner, resolveOwner } from './resolve-owner'
import type { WorktreeOperationRouteState } from './worktree-operation-route'

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

export const FILE_OWNER_UNRESOLVED_MESSAGE =
  "Couldn't verify which host owns this file. Reopen the file and try again."

/**
 * Transport to the worktree's owner, from its rows alone. `null` when rows disagree, so the caller
 * refuses instead of guessing.
 */
export function getRuntimeTargetForWorktreeOwner(
  state: WorktreeOperationRouteState,
  worktreeId: string | null | undefined
): RuntimeClientTarget | null {
  if (!worktreeId) {
    return LOCAL_TARGET
  }
  const target = runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId })
  if (target) {
    return target
  }
  // Missing unstamped workspace rows retain app-local routing; tabs/drops explicitly stamp server owners when present.
  return resolveOwner(state, { workspaceId: worktreeId }).kind === 'missing' ? LOCAL_TARGET : null
}

/** Prefer the tab’s stamped owner (null means this app), then workspace owner; focused server can change after opening. */
export function getRuntimeTargetForFileOwner(
  state: WorktreeOperationRouteState,
  worktreeId: string | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): RuntimeClientTarget | null {
  return runtimeEnvironmentId === undefined
    ? getRuntimeTargetForWorktreeOwner(state, worktreeId)
    : runtimeTargetForOwnerEnvironment(runtimeEnvironmentId)
}

/** {@link getRuntimeTargetForFileOwner} for a caller with an error path. */
export function requireRuntimeTargetForFileOwner(
  state: WorktreeOperationRouteState,
  worktreeId: string | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): RuntimeClientTarget {
  const target = getRuntimeTargetForFileOwner(state, worktreeId, runtimeEnvironmentId)
  if (!target) {
    throw new Error(FILE_OWNER_UNRESOLVED_MESSAGE)
  }
  return target
}
