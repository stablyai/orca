import {
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import { buildExecutionHostRegistry } from '../execution-host-registry'
import type { FolderWorkspace } from '../folder-workspace-types'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts,
  type HostScopedRepoKey
} from '../repo-host-identity'
import type { Repo } from '../repo-types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'
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
import type { PairedServerWorkspaceRow } from './paired-server-rows'
import type { WorkspaceRow } from './workspace-rows'

// By row object: a feed snapshot keeps an unchanged row's object, so only a changed row is read again.
type FeedRow = WorkspaceRow | PairedServerWorkspaceRow
const workspaceByRow = new WeakMap<
  FeedRow,
  { identity: string | undefined; read: SidebarFeedWorkspace | null }
>()

/** `identity`: the key a host's own row is listed under; a paired server's row carries its own. */
function readRemembered(
  row: FeedRow,
  read: () => SidebarFeedWorkspace | null,
  identity?: string
): SidebarFeedWorkspace | null {
  const remembered = workspaceByRow.get(row)
  if (remembered && remembered.identity === identity) {
    return remembered.read
  }
  const next = read()
  workspaceByRow.set(row, { identity, read: next })
  return next
}

function readFeedWorkspaces(domains: SidebarFeedDomains): SidebarFeedWorkspace[] {
  return [
    ...[...domains.workspaces].flatMap(
      ([identity, row]) =>
        readRemembered(row, () => readFeedWorkspaceRow(identity, row), identity) ?? []
    ),
    ...[...domains.pairedServerRows.values()].flatMap(
      (row) => readRemembered(row, () => readFeedPairedServerRow(row)) ?? []
    )
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
  /** By repo id, for what is one per project (sections, labels); one host's registration wins. */
  repoMap: Map<string, Repo>
  /** The registration a workspace belongs to; the same repo id may be registered on several hosts. */
  repoOf: (worktree: Pick<Worktree, 'repoId' | 'hostId'>) => Repo | undefined
}

/** Prefer the row host’s registration; missing same-ID registrations use repoMap fallback like the window. */
function repoOfWorktree(
  repoMap: ReadonlyMap<string, Repo>,
  reposByKey: ReadonlyMap<HostScopedRepoKey, Repo>,
  worktree: Pick<Worktree, 'repoId' | 'hostId'>
): Repo | undefined {
  // An unqualified row is a local one whose metadata names no host (workspace-rows.ts).
  const hostId = worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  return (
    reposByKey.get(getRepoHostIdentityForParts(worktree.repoId, hostId)) ??
    repoMap.get(worktree.repoId)
  )
}

export function indexSidebarFeed(
  domains: SidebarFeedDomains,
  repos: readonly Repo[]
): SidebarFeedIndex {
  const workspaces = readFeedWorkspaces(domains)
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const reposByKey = new Map(repos.map((repo) => [getRepoHostIdentity(repo), repo]))
  return {
    workspaces,
    worktrees: workspaces.flatMap((entry) => (entry.folderWorkspace ? [] : [entry.worktree])),
    folderWorkspaces: workspaces.flatMap((entry) => entry.folderWorkspace ?? []),
    repoMap,
    repoOf: (worktree) => repoOfWorktree(repoMap, reposByKey, worktree)
  }
}

/** Host identities in the owning hosts' stamp order for the sort mode; reads no clock. */
export function rankSidebarFeedWorktrees(
  index: SidebarFeedIndex,
  sortBy: SortBy
): HostScopedWorktreeKey[] {
  return sortWorktreesByStamps(
    index.worktrees.filter((worktree) => !worktree.isArchived),
    sortBy,
    index.repoMap
  ).map(getWorktreeHostIdentity)
}

/** Keep prior Recent stamps for existing rows during project recency hold; new rows retain live stamps. */
export function withHeldProjectRecency(
  live: SidebarFeedIndex,
  heldFrom: SidebarFeedIndex
): SidebarFeedIndex {
  const heldAt = new Map(
    heldFrom.worktrees.map((worktree) => [
      getWorktreeHostIdentity(worktree),
      worktree.lastActivityAt
    ])
  )
  let changed = false
  const worktrees = live.worktrees.map((worktree) => {
    const lastActivityAt = heldAt.get(getWorktreeHostIdentity(worktree)) ?? worktree.lastActivityAt
    if (lastActivityAt === worktree.lastActivityAt) {
      return worktree
    }
    changed = true
    return { ...worktree, lastActivityAt }
  })
  return changed ? { ...live, worktrees } : live
}
