import { getRepoHostIdentity, getRepoHostIdentityForParts } from '../repo-host-identity'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../execution-host'
import type { ExecutionHostId } from '../execution-host'
import {
  getHostContextLabel,
  getMixedHostContextLabels as getSharedMixedHostContextLabels
} from '../worktree/host-context-labels'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { getProjectGroupingForRepo, type ProjectGroupingIndex } from '../project-section-grouping'
import type { WorktreeGroupEntry } from './worktree-group-entry'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import type { GroupHeaderRow, RepoOfWorktree } from './row-types'

export function getMixedHostContextLabels(
  hostIds: Iterable<ExecutionHostId>,
  hostLabelById: ReadonlyMap<string, string> | undefined
): Map<ExecutionHostId, string> | undefined {
  const hosts = new Set(hostIds)
  return hosts.size > 1
    ? new Map([...hosts].map((host) => [host, getHostContextLabel(host, { hostLabelById })]))
    : undefined
}

/** Project observed hosts onto already admitted concrete targets; membership belongs to section preparation. */
export function getProjectHeaderHostRepos(args: {
  anchorHostId: ExecutionHostId
  observedHostIds: ReadonlySet<ExecutionHostId>
  firstRepoByHost: ReadonlyMap<ExecutionHostId, Repo>
}): Map<ExecutionHostId, Repo> | undefined {
  if (
    args.observedHostIds.size === 0 ||
    (args.observedHostIds.size === 1 && args.observedHostIds.has(args.anchorHostId))
  ) {
    return undefined
  }
  const hostRepos = new Map<ExecutionHostId, Repo>()
  for (const host of args.observedHostIds) {
    const repo = args.firstRepoByHost.get(host)
    if (repo) {
      hostRepos.set(host, repo)
    }
  }
  return hostRepos.size > 0 ? hostRepos : undefined
}

export function getProjectHeaderHostScope(
  ctx: { repoOf: RepoOfWorktree; defaultHostId: ExecutionHostId },
  group: WorktreeGroupEntry,
  section: Parameters<typeof getProjectHeaderHostRepos>[0]
): Pick<GroupHeaderRow, 'hostRepos' | 'hostWorktreeCounts' | 'hostWorktreeIds'> {
  const hostRepos = getProjectHeaderHostRepos(section)
  if (!hostRepos) {
    return {}
  }
  const hostWorktreeIds = getHostWorktreeIds(group.items, ctx.repoOf, ctx.defaultHostId)
  return {
    hostRepos,
    hostWorktreeCounts: hostWorktreeIds
      ? new Map([...hostWorktreeIds].map(([hostId, ids]) => [hostId, ids.length]))
      : undefined,
    hostWorktreeIds
  }
}

/** Label notice rows by project-wide host ambiguity, even when rendered in pinned fallback.
 * allRepoIds decides ambiguity unfiltered; filtered noticeRepoIds gates eligibility so filters cannot make labels flicker. */
export type NoticeHostContext = {
  label: string
  /** Retain host identity for the card-compatible glyph/tooltip; label alone cannot select it. */
  hostId: ExecutionHostId
}

export function getNoticeHostContextLabels(
  noticeRepos: Iterable<Repo>,
  allRepos: Iterable<Repo>,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): Map<string, NoticeHostContext> | undefined {
  const hostsByProject = new Map<string, Set<string>>()
  const retain = (key: string, hostId: ExecutionHostId) => {
    const hosts = hostsByProject.get(key) ?? new Set<string>()
    hosts.add(hostId)
    hostsByProject.set(key, hosts)
  }
  for (const group of projectIndex?.groupByKey.values() ?? []) {
    for (const setup of group.registrations) {
      retain(group.key, setup.hostId)
    }
  }
  for (const repo of allRepos) {
    const host = getRepoExecutionHostId(repo)
    const key =
      projectIndex?.groupByRepoHost.get(getRepoHostIdentity(repo))?.key ??
      getProjectGroupingForRepo(repo.id, repoMap, projectIndex, host).key
    retain(key, host)
  }
  const candidates = new Map<string, { key: string; hostId: ExecutionHostId }>()
  for (const repo of noticeRepos) {
    const hostId = getRepoExecutionHostId(repo)
    const key =
      projectIndex?.groupByRepoHost.get(getRepoHostIdentity(repo))?.key ??
      getProjectGroupingForRepo(repo.id, repoMap, projectIndex, hostId).key
    retain(key, hostId)
    candidates.set(getRepoHostIdentityForParts(repo.id, hostId), { key, hostId })
  }
  const mixed = new Map<string, NoticeHostContext>()
  for (const [identity, { key, hostId }] of candidates) {
    if ((hostsByProject.get(key)?.size ?? 0) > 1) {
      mixed.set(identity, { label: getHostContextLabel(hostId, { hostLabelById }), hostId })
    }
  }
  return mixed.size > 0 ? mixed : undefined
}

/** Keyed by host-qualified identity: two hosts sharing an id need two labels. */
export function getMixedWorktreeHostContextLabels(
  worktrees: readonly Worktree[],
  repoOf: RepoOfWorktree,
  hostLabelById: ReadonlyMap<string, string> | undefined,
  defaultHostId: ExecutionHostId
): Map<string, string> | undefined {
  return getSharedMixedHostContextLabels(worktrees, {
    getHostId: (worktree) => getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId),
    getIdentity: getWorktreeHostIdentity,
    sources: { hostLabelById }
  })
}

export function getHostWorktreeCounts(
  worktrees: readonly Worktree[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, number> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  // Reuse the ID dedupe walk; same-ID workspaces on two hosts count under each host (STA-4343).
  const idsByHost = getHostWorktreeIds(worktrees, repoOf, defaultHostId)
  if (!idsByHost) {
    return undefined
  }
  const counts = new Map<ExecutionHostId, number>()
  for (const [hostId, ids] of idsByHost) {
    counts.set(hostId, ids.length)
  }
  return counts
}

export function getHostWorktreeIds(
  worktrees: readonly Worktree[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, string[]> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  const idsByHost = new Map<ExecutionHostId, string[]>()
  const seenIdentities = new Set<string>()
  for (const worktree of worktrees) {
    const identity = getWorktreeHostIdentity(worktree)
    if (seenIdentities.has(identity)) {
      continue
    }
    seenIdentities.add(identity)
    const hostId = getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId)
    const ids = idsByHost.get(hostId) ?? []
    ids.push(worktree.id)
    idsByHost.set(hostId, ids)
  }
  return idsByHost
}

/** Folder-only lanes still need host counts; undefined would render their headers globally (#15362). */
export function getLaneHostWorktreeCounts(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly RenderableFolderWorkspace[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, number> | undefined {
  if (worktrees.length === 0 && folderWorkspaces.length === 0) {
    return undefined
  }
  const counts = getHostWorktreeCounts(worktrees, repoOf, defaultHostId) ?? new Map()
  for (const { folderWorkspace, projectGroup } of folderWorkspaces) {
    const hostId = getFolderWorkspaceHostId(folderWorkspace, projectGroup, defaultHostId)
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1)
  }
  return counts
}

/** Folder hosts need explicit empty worktree-ID arrays; missing keys trigger global-ID fallbacks into that host section. */
export function getLaneHostWorktreeIds(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly RenderableFolderWorkspace[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, string[]> | undefined {
  if (worktrees.length === 0 && folderWorkspaces.length === 0) {
    return undefined
  }
  const idsByHost = getHostWorktreeIds(worktrees, repoOf, defaultHostId) ?? new Map()
  for (const { folderWorkspace, projectGroup } of folderWorkspaces) {
    const hostId = getFolderWorkspaceHostId(folderWorkspace, projectGroup, defaultHostId)
    if (!idsByHost.has(hostId)) {
      idsByHost.set(hostId, [])
    }
  }
  return idsByHost
}
