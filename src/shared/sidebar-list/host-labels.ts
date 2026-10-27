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
import type { RepoOfWorktree } from './row-types'

function getRepoHostId(repoId: string, repoMap: Map<string, Repo>): ExecutionHostId | null {
  const repo = repoMap.get(repoId)
  return repo ? getRepoExecutionHostId(repo) : null
}

function getRepoHostLabel(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): string | null {
  const setup = projectIndex?.setupByRepoId.get(repoId)
  if (setup) {
    return getHostContextLabel(setup.hostId, { hostLabelById })
  }
  const repo = repoMap.get(repoId)
  if (!repo) {
    return null
  }
  const hostId = getRepoExecutionHostId(repo)
  return getHostContextLabel(hostId, { hostLabelById })
}

export function getMixedHostContextLabels(
  group: WorktreeGroupEntry,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): Map<string, string> | undefined {
  const labelsByRepoId = new Map<string, string>()
  // Host identity, not the rendered label, determines whether rows are ambiguous:
  // two hosts can intentionally share a user-facing label.
  const uniqueHostIds = new Set<ExecutionHostId>()
  for (const repoId of group.repoIds) {
    const label = getRepoHostLabel(repoId, repoMap, projectIndex, hostLabelById)
    if (!label) {
      continue
    }
    labelsByRepoId.set(repoId, label)
    const setup = projectIndex?.setupByRepoId.get(repoId)
    const hostId = setup?.hostId ?? getRepoHostId(repoId, repoMap)
    if (hostId) {
      uniqueHostIds.add(hostId)
    }
  }
  return uniqueHostIds.size > 1 ? labelsByRepoId : undefined
}

/** Label notice rows by project-wide host ambiguity, even when rendered in pinned fallback.
 * allRepoIds decides ambiguity unfiltered; filtered noticeRepoIds gates eligibility so filters cannot make labels flicker. */
export type NoticeHostContext = {
  label: string
  /** Retain host identity for the card-compatible glyph/tooltip; label alone cannot select it. */
  hostId: ExecutionHostId
}

export function getNoticeHostContextLabels(
  noticeRepoIds: Iterable<string>,
  allRepoIds: Iterable<string>,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): Map<string, NoticeHostContext> | undefined {
  const eligible = new Set(noticeRepoIds)
  if (eligible.size === 0) {
    return undefined
  }
  // Count host IDs, not labels: distinct hosts may deliberately share a display name.
  const hostIdsForProject = new Map<string, Set<string>>()
  const labelsByRepoId = new Map<string, NoticeHostContext>()
  const projectKeyByRepoId = new Map<string, string>()
  for (const repoId of allRepoIds) {
    const label = getRepoHostLabel(repoId, repoMap, projectIndex, hostLabelById)
    if (!label) {
      continue
    }
    const projectKey = getProjectGroupingForRepo(repoId, repoMap, projectIndex).projectId ?? repoId
    const hostId = projectIndex?.setupByRepoId.get(repoId)?.hostId ?? getRepoHostId(repoId, repoMap)
    if (hostId) {
      const hostIds = hostIdsForProject.get(projectKey) ?? new Set<string>()
      hostIds.add(hostId)
      hostIdsForProject.set(projectKey, hostIds)
    }
    if (eligible.has(repoId) && hostId) {
      labelsByRepoId.set(repoId, { label, hostId: hostId as ExecutionHostId })
      projectKeyByRepoId.set(repoId, projectKey)
    }
  }
  const mixed = new Map<string, NoticeHostContext>()
  for (const [repoId, context] of labelsByRepoId) {
    const projectKey = projectKeyByRepoId.get(repoId)
    if (projectKey && (hostIdsForProject.get(projectKey)?.size ?? 0) > 1) {
      mixed.set(repoId, context)
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
