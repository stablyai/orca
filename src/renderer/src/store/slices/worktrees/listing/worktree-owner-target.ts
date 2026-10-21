import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { resolveOwner, runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { hostRouteForAuthority, type HostRoute } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { AppState } from '../../../types'
import { ambiguousWorkspaceOwnerMessage } from '@/lib/duplicate-paired-servers'
import { WORKTREE_REMOVAL_AMBIGUOUS_ERROR } from './worktree-slice-constants'

/** Transport to the worktree's owner (on `executionHostId` when given), or `null` when unresolved. */
export function tryRuntimeTargetForWorktreeOwner(
  state: AppState,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): RuntimeClientTarget | null {
  return runtimeTargetForWorkspaceOwner(state, {
    workspaceId: worktreeId,
    ...(executionHostId ? { hostId: executionHostId } : {})
  })
}

/** {@link tryRuntimeTargetForWorktreeOwner}, refusing an unresolved owner. */
export function runtimeTargetForWorktreeOwner(
  state: AppState,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): RuntimeClientTarget {
  const target = tryRuntimeTargetForWorktreeOwner(state, worktreeId, executionHostId)
  if (!target) {
    // Why only unqualified: a named host picks its own row, so twins cannot be the cause.
    throw new Error(
      executionHostId
        ? WORKTREE_REMOVAL_AMBIGUOUS_ERROR
        : ambiguousWorkspaceOwnerMessage(state, worktreeId)
    )
  }
  return target
}

/** The owner's transport and place together, refusing an unresolved owner. */
export function hostRouteForWorktreeOwner(state: AppState, worktreeId: string): HostRoute {
  const match = resolveOwner(state, { workspaceId: worktreeId })
  if (match.kind !== 'resolved') {
    throw new Error(ambiguousWorkspaceOwnerMessage(state, worktreeId))
  }
  return hostRouteForAuthority(match.owner)
}
