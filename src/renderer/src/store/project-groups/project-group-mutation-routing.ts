import type { AppState } from '../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import {
  resolveProjectGroupOwnerHostId,
  settingsForProjectGroupOwner
} from '../slices/project-group-owner-routing'
import {
  findIndexedProjectGroupOwner,
  getCatalogOwnerHostId,
  isProjectGroupIdAmbiguous
} from '@/lib/worktree-runtime-owner-index'

export type ProjectGroupRuntimeTarget = {
  target: ReturnType<typeof getActiveRuntimeTarget>
  ownerHostId: ExecutionHostId
}

export function getProjectGroupTargetHostId(
  target: ReturnType<typeof getActiveRuntimeTarget>
): ExecutionHostId {
  return target.kind === 'environment'
    ? toRuntimeExecutionHostId(target.environmentId)
    : LOCAL_EXECUTION_HOST_ID
}

export function getProjectGroupRuntimeTarget(
  state: Pick<AppState, 'projectGroups' | 'settings'>,
  groupId: string,
  executionHostId?: ExecutionHostId
): ProjectGroupRuntimeTarget | null {
  const owner = findIndexedProjectGroupOwner(state.projectGroups, groupId, executionHostId)
  if (owner) {
    const ownerHost = parseExecutionHostId(owner.executionHostId)
    return {
      target:
        ownerHost?.kind === 'runtime'
          ? { kind: 'environment', environmentId: ownerHost.environmentId }
          : { kind: 'local' },
      ownerHostId: getCatalogOwnerHostId(owner)
    }
  }
  // Why: explicit or ambiguous ownership must not fall back to the focused host.
  if (executionHostId || isProjectGroupIdAmbiguous(state.projectGroups, groupId)) {
    return null
  }
  const target = getActiveRuntimeTarget(state.settings)
  return {
    target,
    ownerHostId: getProjectGroupTargetHostId(target)
  }
}

export function resolveProjectGroupMutationTarget(
  state: Pick<AppState, 'projectGroups' | 'settings'>,
  groupId: string,
  options?: { executionHostId?: ExecutionHostId; hostId?: ExecutionHostId }
): ProjectGroupRuntimeTarget | null {
  const requestedHostId = options?.executionHostId ?? options?.hostId
  const executionTarget = options?.executionHostId
    ? getProjectGroupRuntimeTarget(state, groupId, options.executionHostId)
    : null
  const resolvedOwnerHostId = resolveProjectGroupOwnerHostId(state, groupId, requestedHostId)
  if (requestedHostId && !resolvedOwnerHostId) {
    return null
  }
  const target =
    executionTarget?.target ??
    getActiveRuntimeTarget(settingsForProjectGroupOwner(state, groupId, requestedHostId))
  return {
    target,
    ownerHostId:
      executionTarget?.ownerHostId ?? resolvedOwnerHostId ?? getProjectGroupTargetHostId(target)
  }
}
