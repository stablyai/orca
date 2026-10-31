import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  findIndexedProjectGroupOwner,
  getCatalogOwnerHostId
} from '@/lib/worktree-runtime-owner-index'

export function resolveProjectGroupMutationTarget(
  state: Pick<AppState, 'projectGroups'>,
  groupId: string,
  options?: { executionHostId?: ExecutionHostId; hostId?: ExecutionHostId }
) {
  const requestedHostId = options?.executionHostId ?? options?.hostId
  const owner = findIndexedProjectGroupOwner(state.projectGroups, groupId, requestedHostId)
  if (!owner) {
    return null
  }
  const ownerHostId = getCatalogOwnerHostId(owner)
  const target = ipcOrRuntimeTargetForHostId(requestedHostId ?? ownerHostId)
  return target ? { target, ownerHostId } : null
}
