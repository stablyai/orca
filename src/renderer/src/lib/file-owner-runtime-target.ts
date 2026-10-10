import {
  runtimeTargetForOwnerEnvironment,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'
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
  // Why local for a missing row: tabs and drops stamp a server owner when one exists, so a
  // workspace with no row yet is this app's — the same answer the read had before focus routing.
  return resolveOwner(state, { workspaceId: worktreeId }).kind === 'missing' ? LOCAL_TARGET : null
}

/**
 * Transport to an open file's owner: the owner stamped on its tab (`null` is this app), else its
 * worktree's owner. Never the focused server, which can change after the tab opened.
 */
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
