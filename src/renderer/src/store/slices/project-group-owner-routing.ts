import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { findIndexedProjectGroupOwner } from '@/lib/worktree-runtime-owner-index'
import {
  runtimeTargetForOwnerHostId,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'

type ProjectGroupHostParts = Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>
type RoutingSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

type ProjectGroupOwnerRoutingState = {
  projectGroups: readonly ProjectGroupOwnerRecord[]
  settings: RoutingSettings
}

// Why: persisted rows predate host stamping and may carry padded/unparseable ids; normalize so
// routing and catalog identity agree on the same owner host.
export function getProjectGroupHostId(group: ProjectGroupHostParts): ExecutionHostId {
  return getRepoExecutionHostId(group)
}

export function catalogOwnsHost(catalogHostId: string, rowHostId: string): boolean {
  if (catalogHostId !== LOCAL_EXECUTION_HOST_ID) {
    return catalogHostId === rowHostId
  }
  return parseExecutionHostId(rowHostId)?.kind !== 'runtime'
}

export function projectGroupMatchesOwnerHost(
  group: ProjectGroupOwnerRecord,
  groupId: string,
  ownerHostId: ExecutionHostId | null
): boolean {
  if (group.id !== groupId) {
    return false
  }
  return ownerHostId ? catalogOwnsHost(ownerHostId, getProjectGroupHostId(group)) : true
}

export function resolveProjectGroupOwnerHostId(
  state: ProjectGroupOwnerRoutingState,
  groupId: string,
  hostId?: ExecutionHostId
): ExecutionHostId | null {
  const owner = findIndexedProjectGroupOwner(state.projectGroups, groupId, hostId)
  if (!owner) {
    return null
  }
  if (hostId) {
    return hostId
  }
  // Why: an unstamped row carries no owner, so keep the focused-host behavior instead of assuming local.
  if (!owner.executionHostId && !owner.connectionId) {
    return null
  }
  return getProjectGroupHostId(owner)
}

/**
 * Transport to the group's owner, so a mutation never follows the focused host; `null` when no
 * row names the group. Direct-SSH groups live in this app's catalog and ride its IPC.
 */
export function runtimeTargetForProjectGroupOwner(
  state: Pick<ProjectGroupOwnerRoutingState, 'projectGroups'>,
  groupId: string,
  hostId?: ExecutionHostId
): RuntimeClientTarget | null {
  const owner = findIndexedProjectGroupOwner(state.projectGroups, groupId, hostId)
  return owner ? runtimeTargetForOwnerHostId(hostId ?? getProjectGroupHostId(owner)) : null
}
