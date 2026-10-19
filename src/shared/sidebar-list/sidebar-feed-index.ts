import {
  getSshTargetIdForExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import { buildExecutionHostRegistry } from '../execution-host-registry'
import type { FolderWorkspace } from '../folder-workspace-types'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import type { HostSectionOption } from './host-section-rows'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import type { SidebarFeedView } from './sidebar-feed-rows'
import {
  readFeedPairedServerRow,
  readFeedWorkspaceRow,
  type SidebarFeedWorkspace
} from './sidebar-feed-worktrees'
import { sortWorktreesByStamps, type SortBy } from './smart-sort'

function readFeedWorkspaces(domains: SidebarFeedDomains): SidebarFeedWorkspace[] {
  return [
    ...[...domains.workspaces].flatMap(
      ([identity, row]) => readFeedWorkspaceRow(identity, row) ?? []
    ),
    ...[...domains.pairedServerRows.values()].flatMap((row) => readFeedPairedServerRow(row) ?? [])
  ]
}

/** The host sections a feed reader lists, labelled from the feed's SSH and paired-server facts. */
export function buildFeedHostOptions(
  domains: SidebarFeedDomains,
  repos: readonly Repo[],
  view: SidebarFeedView
): HostSectionOption[] {
  const servers = [...domains.pairedServerHosts].flatMap(([hostId, { host }]) => {
    const parsed = parseExecutionHostId(hostId)
    return parsed?.kind === 'runtime' && host ? [{ parsed, host }] : []
  })
  const serverLabelByHostId = new Map<ExecutionHostId, string>(
    servers.map(({ parsed, host }) => [parsed.id, host.label])
  )
  const focused = parseExecutionHostId(view.defaultHostId)
  return buildExecutionHostRegistry({
    repos,
    settings: {
      activeRuntimeEnvironmentId: focused?.kind === 'runtime' ? focused.environmentId : null
    },
    sshTargetLabels: new Map(
      Object.entries(domains.desktop?.sshHosts ?? {}).flatMap(([hostId, host]) => {
        const targetId = getSshTargetIdForExecutionHost(hostId)
        return targetId ? [[targetId, host.label] as const] : []
      })
    ),
    runtimeEnvironments: servers.map(({ parsed, host }) => ({
      id: parsed.environmentId,
      name: host.label
    })),
    hostLabelOverrides: view.hostLabelOverrides,
    localHostLabel: view.localHostLabel
  }).map((host) => {
    const label = serverLabelByHostId.get(host.id)
    return label ? { ...host, label } : host
  })
}

/** The feed's workspaces indexed the way the builder reads them; one read serves order and plan. */
export type SidebarFeedIndex = {
  workspaces: SidebarFeedWorkspace[]
  /** Every git workspace, archived ones included; folder rows are listed apart. */
  worktrees: Worktree[]
  folderWorkspaces: FolderWorkspace[]
  repoMap: Map<string, Repo>
}

export function indexSidebarFeed(
  domains: SidebarFeedDomains,
  repos: readonly Repo[]
): SidebarFeedIndex {
  const workspaces = readFeedWorkspaces(domains)
  return {
    workspaces,
    worktrees: workspaces.flatMap((entry) => (entry.folderWorkspace ? [] : [entry.worktree])),
    folderWorkspaces: workspaces.flatMap((entry) => entry.folderWorkspace ?? []),
    repoMap: new Map(repos.map((repo) => [repo.id, repo]))
  }
}

/** The ids in the owning hosts' stamp order for the sort mode; reads no clock. */
export function rankSidebarFeedWorktrees(index: SidebarFeedIndex, sortBy: SortBy): string[] {
  return sortWorktreesByStamps(
    index.worktrees.filter((worktree) => !worktree.isArchived),
    sortBy,
    index.repoMap
  ).map((worktree) => worktree.id)
}
