import type { AppState } from '../../../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type { WorktreePurgeTarget } from './worktree-purge-target'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspaces/folder-workspace-host-id'
import { getProjectGroupHostId } from '../../../project-groups/project-group-owner-routing'
import { getRepoHostSummaries } from '../listing/worktree-host-ownership'
import { selectFolderWorkspaces } from '../../../workspaces/catalog/workspace-record-fields'
import {
  worktreePurgePublishers,
  type PurgePublisher
} from '../../../repos/repo-removal-publisher-index'

function purgedPublisherMatcher(
  s: AppState,
  repoId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>
) {
  const positions = new Map([...purgedHosts].map((hostId, index) => [hostId, index]))
  const runtimeHostsByEnvironment = new Map<string, ExecutionHostId>()
  for (const hostId of purgedHosts) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime' && !runtimeHostsByEnvironment.has(parsed.environmentId)) {
      runtimeHostsByEnvironment.set(parsed.environmentId, hostId)
    }
  }
  return (row: PurgePublisher): ExecutionHostId | undefined => {
    if (row.runtimeOwnerEnvironmentId) {
      return runtimeHostsByEnvironment.get(row.runtimeOwnerEnvironmentId)
    }
    if (row.hostId) {
      return purgedHosts.has(row.hostId) ? row.hostId : undefined
    }
    const localPosition = positions.get(LOCAL_EXECUTION_HOST_ID)
    if (localPosition === 0 || purgedHosts.size === 0) {
      return localPosition === 0 ? LOCAL_EXECUTION_HOST_ID : undefined
    }
    // Only legacy unhosted rows can need the sole-repo-owner fallback.
    const soleOwner = getRepoHostSummaries(s.repos).get(repoId)?.onlyHostId
    const ownerPosition = soleOwner ? positions.get(soleOwner) : undefined
    return ownerPosition !== undefined &&
      (localPosition === undefined || ownerPosition < localPosition)
      ? soleOwner
      : localPosition !== undefined
        ? LOCAL_EXECUTION_HOST_ID
        : undefined
  }
}

/** Resolve surviving publishers and purged attribution with listing rules; legacy unstamped and runtime-proxied SSH rows may be the purged copy, not twins. */
function resolvePurgedPublishers(
  s: AppState,
  workspaceId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>
): { survivors: ExecutionHostId[]; attributedHostIds: Map<ExecutionHostId, ExecutionHostId> } {
  const scope = parseWorkspaceKey(workspaceId)
  const attributedHostIds = new Map([...purgedHosts].map((hostId) => [hostId, hostId]))
  if (scope?.type === 'folder') {
    const groups = s.projectGroups ?? []
    const hosts = (selectFolderWorkspaces(s) ?? [])
      .filter((folder) => folder.id === scope.folderWorkspaceId)
      .flatMap((folder) => {
        const groupHosts = groups
          .filter((group) => group.id === folder.projectGroupId)
          .map(getProjectGroupHostId)
        // Why every group host: an unstamped folder under a group two hosts publish may be either's.
        return folder.executionHostId || folder.connectionId || groupHosts.length === 0
          ? [getFolderWorkspaceHostId(folder, groups)]
          : groupHosts
      })
    return {
      survivors: [...new Set(hosts)].filter((hostId) => !purgedHosts.has(hostId)),
      attributedHostIds
    }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const rows = worktreePurgePublishers(s, worktreeId).rows()
  const matchPurgedHost = purgedPublisherMatcher(s, repoId, purgedHosts)
  const survivors = new Set<ExecutionHostId>()
  for (const row of rows) {
    const purgedHost = matchPurgedHost(row)
    if (purgedHost) {
      // Why: a copy reached through a paired runtime stamps its tabs with its own SSH host.
      if (row.hostId && !purgedHosts.has(row.hostId)) {
        attributedHostIds.set(purgedHost, row.hostId)
      }
      continue
    }
    survivors.add(
      row.hostId ??
        (row.runtimeOwnerEnvironmentId
          ? toRuntimeExecutionHostId(row.runtimeOwnerEnvironmentId)
          : LOCAL_EXECUTION_HOST_ID)
    )
  }
  return {
    survivors: [...survivors].filter((hostId) => !purgedHosts.has(hostId)),
    attributedHostIds
  }
}

/** Every host whose listing publishes this id; empty when no row names it. */
export function workspacePublishingHosts(s: AppState, workspaceId: string): ExecutionHostId[] {
  return resolvePurgedPublishers(s, workspaceId, new Set()).survivors
}

/** Per attributed host, its twin ids with the hosts that still publish them. */
export type HostTwinPurgeScopes = Map<ExecutionHostId, Map<string, ExecutionHostId[]>>

/** Host targets whose id a host outside the purge still publishes. A raw id for the same id wins. */
export function collectHostTwinPurgeScopes(
  s: AppState,
  targets: readonly WorktreePurgeTarget[]
): HostTwinPurgeScopes {
  const rawIds = new Set(targets.filter((target) => !target.hostId).map((target) => target.id))
  const purgedHostsById = new Map<string, Set<ExecutionHostId>>()
  for (const { id, hostId } of targets) {
    if (hostId && !rawIds.has(id)) {
      purgedHostsById.set(id, (purgedHostsById.get(id) ?? new Set()).add(hostId))
    }
  }
  const scopes: HostTwinPurgeScopes = new Map()
  for (const [id, purgedHosts] of purgedHostsById) {
    const { survivors, attributedHostIds } = resolvePurgedPublishers(s, id, purgedHosts)
    if (survivors.length === 0) {
      continue
    }
    for (const hostId of purgedHosts) {
      const attributedHostId = attributedHostIds.get(hostId) ?? hostId
      const scope = scopes.get(attributedHostId) ?? new Map<string, ExecutionHostId[]>()
      scopes.set(attributedHostId, scope.set(id, survivors))
    }
  }
  return scopes
}
