import type { AppState } from '../../../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspaces/folder-workspace-host-id'
import { getProjectGroupHostId } from '../../project-group-owner-routing'
import {
  getRepoHostSummaries,
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '../listing/worktree-host-ownership'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../../workspace-record-selectors'

type PublisherRow = {
  id: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}
type FolderRow = NonNullable<AppState['folderWorkspaces']>[number]
type GroupRow = NonNullable<AppState['projectGroups']>[number]

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>()
  for (const row of rows) {
    const k = key(row)
    const group = grouped.get(k)
    if (group) {
      group.push(row)
    } else {
      grouped.set(k, [row])
    }
  }
  return grouped
}

/** One purge's listings grouped by id on first use, so each publisher row is read once however
 *  many of its ids or hosts the purge names. */
export type PublisherIndex = {
  worktreeRows: (repoId: string, worktreeId: string) => readonly PublisherRow[]
  folders: (folderWorkspaceId: string) => readonly FolderRow[]
  groups: (groupId: string) => readonly GroupRow[]
}

export function createPublisherIndex(s: AppState): PublisherIndex {
  const rowsByRepo = new Map<string, Map<string, PublisherRow[]>>()
  let foldersById: Map<string, FolderRow[]> | undefined
  let groupsById: Map<string, GroupRow[]> | undefined
  return {
    worktreeRows: (repoId, worktreeId) => {
      let byId = rowsByRepo.get(repoId)
      if (!byId) {
        const rows: PublisherRow[] = [
          ...(selectWorktreesByRepo(s)[repoId] ?? []),
          ...(selectDetectedWorktreesByRepo(s)[repoId]?.worktrees ?? [])
        ]
        byId = groupBy(rows, (row) => row.id)
        rowsByRepo.set(repoId, byId)
      }
      return byId.get(worktreeId) ?? []
    },
    folders: (folderWorkspaceId) =>
      (foldersById ??= groupBy(selectFolderWorkspaces(s) ?? [], (folder) => folder.id)).get(
        folderWorkspaceId
      ) ?? [],
    groups: (groupId) =>
      (groupsById ??= groupBy(s.projectGroups ?? [], (group) => group.id)).get(groupId) ?? []
  }
}

/** The purged host a listing row belongs to, by the listing's own match: a row names its host by
 *  runtime owner, by stamp or, unstamped, as local or the repo's only owner, so at most two purged
 *  hosts are tried per row, in the purge's order. */
function purgedHostOfRow(
  s: AppState,
  repoId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>
): (row: PublisherRow) => ExecutionHostId | undefined {
  const order = new Map<ExecutionHostId, number>()
  const byEnvironment = new Map<string, ExecutionHostId>()
  for (const hostId of purgedHosts) {
    order.set(hostId, order.size)
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime' && !byEnvironment.has(parsed.environmentId)) {
      byEnvironment.set(parsed.environmentId, hostId)
    }
  }
  const summary = getRepoHostSummaries(s.repos).get(repoId)
  const unstamped = [...order.keys()]
    .filter(
      (hostId) =>
        hostId === LOCAL_EXECUTION_HOST_ID ||
        (summary?.count === 1 && hostId === summary.onlyHostId)
    )
    .sort((a, b) => order.get(a)! - order.get(b)!)
  return (row) => {
    const candidates = row.runtimeOwnerEnvironmentId
      ? [byEnvironment.get(row.runtimeOwnerEnvironmentId)]
      : row.hostId
        ? [order.has(row.hostId) ? row.hostId : undefined]
        : unstamped
    return candidates.find(
      (hostId): hostId is ExecutionHostId =>
        !!hostId && worktreeMatchesHost(row, hostId, worktreeHostMatchOptions(s, repoId, hostId))
    )
  }
}

export type PurgedPublishers = {
  survivors: ExecutionHostId[]
  attributedHostIds: Map<ExecutionHostId, ExecutionHostId>
  /** The hosts an attributed host's launches under this id may name: itself and, unless a
   *  survivor, the paired runtime its row was reached through. */
  launchHostsFor: (attributedHostId: ExecutionHostId) => ExecutionHostId[]
}

/** Resolve surviving publishers and purged attribution with listing rules; legacy unstamped and runtime-proxied SSH rows may be the purged copy, not twins. */
export function resolvePurgedPublishers(
  s: AppState,
  workspaceId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>,
  index: PublisherIndex = createPublisherIndex(s)
): PurgedPublishers {
  const scope = parseWorkspaceKey(workspaceId)
  const attributedHostIds = new Map([...purgedHosts].map((hostId) => [hostId, hostId]))
  if (scope?.type === 'folder') {
    const hosts = index.folders(scope.folderWorkspaceId).flatMap((folder) => {
      const groupHosts = index.groups(folder.projectGroupId).map(getProjectGroupHostId)
      // Why every group host: an unstamped folder under a group two hosts publish may be either's.
      return folder.executionHostId || folder.connectionId || groupHosts.length === 0
        ? [getFolderWorkspaceHostId(folder, s.projectGroups ?? [])]
        : groupHosts
    })
    return {
      survivors: [...new Set(hosts)].filter((hostId) => !purgedHosts.has(hostId)),
      attributedHostIds,
      launchHostsFor: (hostId) => [hostId]
    }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const purgedHostOf = purgedHostOfRow(s, repoId, purgedHosts)
  const survivors = new Set<ExecutionHostId>()
  // Why the raw id only: a launch's alias comes from the row stamped with the removed host.
  const stampedRows = new Map<ExecutionHostId, PublisherRow>()
  for (const row of index.worktreeRows(repoId, worktreeId)) {
    if (row.hostId && worktreeId === workspaceId && !stampedRows.has(row.hostId)) {
      stampedRows.set(row.hostId, row)
    }
    const purgedHost = purgedHostOf(row)
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
  for (const hostId of purgedHosts) {
    survivors.delete(hostId)
  }
  return {
    survivors: [...survivors],
    attributedHostIds,
    launchHostsFor: (hostId) => {
      const owner = stampedRows.get(hostId)?.runtimeOwnerEnvironmentId?.trim()
      const proxy = owner ? toRuntimeExecutionHostId(owner) : undefined
      return proxy && proxy !== hostId && !survivors.has(proxy) ? [hostId, proxy] : [hostId]
    }
  }
}
