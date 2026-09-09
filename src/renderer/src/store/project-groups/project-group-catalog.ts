import type { ProjectGroup } from '../../../../shared/project-group-types'
import { callRuntimeRpc, type RuntimeClientTarget } from '../../runtime/runtime-rpc-client'
import { catalogOwnsHost, getProjectGroupHostId } from '../slices/project-group-owner-routing'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { projectGroupWithFetchedOwner } from './project-group-owner-stamping'
import { mergeByIdentity, unchangedMergeSource } from '../catalog-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type FetchedProjectGroupCatalog = {
  projectGroups: ProjectGroup[]
  hostId: ExecutionHostId
}

function getProjectGroupHostIdentity(group: ProjectGroup): string {
  return JSON.stringify([getProjectGroupHostId(group), group.id])
}

function mergeFetchedProjectGroupsForHost(
  previous: readonly ProjectGroup[],
  fetched: ProjectGroup[],
  hostId: string
): readonly ProjectGroup[] {
  const fetchedIdentities = new Set(fetched.map(getProjectGroupHostIdentity))
  const preserved = previous.filter((group) => {
    const existingHostId = getProjectGroupHostId(group)
    return (
      !catalogOwnsHost(hostId, existingHostId) ||
      fetchedIdentities.has(getProjectGroupHostIdentity(group))
    )
  })
  return unchangedMergeSource(
    previous,
    preserved,
    mergeByIdentity(preserved, fetched, getProjectGroupHostIdentity)
  )
}

export async function fetchProjectGroupCatalogForTarget(
  target: RuntimeClientTarget
): Promise<FetchedProjectGroupCatalog> {
  const fetchedGroups =
    target.kind === 'local'
      ? await window.api.projectGroups.list()
      : (
          await callRuntimeRpc<{ groups: ProjectGroup[] }>(target, 'projectGroup.list', undefined, {
            timeoutMs: 15_000,
            reuseRecentCompatibilityFailure: true
          })
        ).groups
  return {
    projectGroups: fetchedGroups.map((group) => projectGroupWithFetchedOwner(group, target)),
    hostId: getRuntimeTargetHostId(target)
  }
}

export function mergeFetchedProjectGroupCatalog(
  catalog: FetchedProjectGroupCatalog,
  currentProjectGroups: readonly ProjectGroup[]
): { projectGroups: readonly ProjectGroup[]; hostId: ExecutionHostId } {
  return {
    projectGroups: mergeFetchedProjectGroupsForHost(
      currentProjectGroups,
      catalog.projectGroups,
      catalog.hostId
    ),
    hostId: catalog.hostId
  }
}
