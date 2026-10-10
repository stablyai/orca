import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ProjectGroup, ProjectGroupUpdates } from '../../../../shared/project-group-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { PROJECT_GROUP_NESTING_RUNTIME_CAPABILITY } from '../../../../shared/project-group-nesting-capability'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from '../../runtime/runtime-rpc-client'
import {
  projectGroupMatchesOwnerHost,
  resolveProjectGroupOwnerHostId,
  settingsForProjectGroupOwner
} from '../slices/project-group-owner-routing'
import { projectGroupWithFetchedOwner } from './project-group-owner-stamping'

// Why: the sidebar lists groups from every host, so the mutation follows the group's owner, not the focused host.
export function createProjectGroupOwnerUpdate(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
) {
  return async (
    groupId: string,
    updates: ProjectGroupUpdates,
    hostId: ExecutionHostId | undefined,
    applied: (group: ProjectGroup) => boolean = () => true
  ): Promise<boolean> => {
    const ownerHostId = resolveProjectGroupOwnerHostId(get(), groupId, hostId)
    const target = getActiveRuntimeTarget(settingsForProjectGroupOwner(get(), groupId, hostId))
    // Why: hosts older than nesting strip parentGroupId, so a move only goes to hosts that advertise it.
    if (
      updates.parentGroupId !== undefined &&
      target.kind === 'environment' &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        PROJECT_GROUP_NESTING_RUNTIME_CAPABILITY,
        15_000
      ))
    ) {
      return false
    }
    const updated =
      target.kind === 'local'
        ? await window.api.projectGroups.update({ groupId, updates })
        : (
            await callRuntimeRpc<{ group: ProjectGroup | null }>(
              target,
              'projectGroup.update',
              { groupId, updates },
              { timeoutMs: 15_000 }
            )
          ).group
    if (!updated || !applied(updated)) {
      return false
    }
    const ownedGroup = projectGroupWithFetchedOwner(updated, target)
    set((s) => ({
      projectGroups: s.projectGroups.map((group) =>
        projectGroupMatchesOwnerHost(group, groupId, ownerHostId) ? ownedGroup : group
      ),
      folderWorkspacePathStatuses: {}
    }))
    return true
  }
}
