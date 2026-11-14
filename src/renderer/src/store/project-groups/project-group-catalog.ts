import type { ProjectGroup } from '../../../../shared/project-group-types'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { catalogOwnsHost } from './project-group-owner-routing'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getRuntimeTargetHostId } from '../../runtime/rpc/targets/runtime-client-target'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import {
  mergeByIdentity,
  unchangedMergeSource
} from '../../lib/catalog-reconciliation/catalog-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type FetchedProjectGroupCatalog = {
  projectGroups: ProjectGroup[]
  hostId: ExecutionHostId
}

function getProjectGroupHostIdentity(group: ProjectGroup): string {
  return JSON.stringify([getRepoExecutionHostId(group), group.id])
}

function mergeFetchedProjectGroupsForHost(
  previous: readonly ProjectGroup[],
  fetched: ProjectGroup[],
  hostId: string
): readonly ProjectGroup[] {
  const fetchedIdentities = new Set(fetched.map(getProjectGroupHostIdentity))
  const preserved = previous.filter((group) => {
    const existingHostId = getRepoExecutionHostId(group)
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
    projectGroups: fetchedGroups.map((group) =>
      adoptFromEndpoint(target, { kind: 'projectGroup', row: group })
    ),
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
