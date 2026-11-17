import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { projectGroupMatchesOwnerHost } from './project-group-owner-routing'
import { initializeNewRootProjectGroupOrder } from './project-group-update-persistence'

/** Creates a group on the given host and adds the host-stamped row to the catalog. */
export function createProjectGroupOnHost(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
) {
  return async (
    target: RuntimeClientTarget,
    args: Parameters<typeof window.api.projectGroups.create>[0]
  ): Promise<ProjectGroup> => {
    const group =
      target.kind === 'local'
        ? await window.api.projectGroups.create(args)
        : (
            await callRuntimeRpc<{ group: ProjectGroup }>(target, 'projectGroup.create', args, {
              timeoutMs: 15_000
            })
          ).group
    const orderedGroup = await initializeNewRootProjectGroupOrder(target, group, get())
    const ownedGroup = adoptFromEndpoint(target, { kind: 'projectGroup', row: orderedGroup })
    const ownerHostId = getRepoExecutionHostId(ownedGroup)
    set((s) => {
      const existing = s.projectGroups.find((entry) =>
        projectGroupMatchesOwnerHost(entry, ownedGroup.id, ownerHostId)
      )
      if (existing && orderedGroup === group) {
        return s
      }
      // Keep newer catalog fields, but include the order confirmed after that refresh.
      const { rootProjectOrder, tabOrder } = ownedGroup
      const nextGroup = existing ? { ...existing, rootProjectOrder, tabOrder } : ownedGroup
      return {
        projectGroups: existing
          ? s.projectGroups.map((entry) => (entry === existing ? nextGroup : entry))
          : [...s.projectGroups, nextGroup],
        folderWorkspacePathStatuses: {}
      }
    })
    return ownedGroup
  }
}
