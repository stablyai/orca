import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getHostContextLabel,
  getMixedHostContextLabels as getSharedMixedHostContextLabels
} from '../../../../../../shared/worktree/host-context-labels'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getProjectGroupingForRepo,
  type ProjectGroupingIndex,
  type WorktreeGroupEntry
} from './project-grouping'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'

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

/**
 * Host labels for the sidebar's notice rows, keyed by repo id.
 *
 * Why not getMixedHostContextLabels: a notice row can render outside its
 * project's own section (pinned fallback), and the ambiguity it resolves
 * belongs to the project — one project checked out on several hosts emits one
 * identical-looking row per host. So the mixed test runs per project.
 *
 * Two inputs, deliberately: `allRepoIds` is the unfiltered universe that decides
 * whether a project spans hosts, and `noticeRepoIds` is the host-filtered set
 * eligible for a label. Deriving both from the filtered set would make a label
 * appear and disappear with the sidebar's host filter.
 */
export type NoticeHostContext = {
  label: string
  /** Carried so the row can draw the same host glyph and "Project on …"
   *  tooltip worktree cards use, which the label alone cannot select. */
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
  // Why host ids and not labels: two hosts can share one user-facing label, and
  // that project spans hosts just the same — counting labels hides exactly the
  // case where the rows are hardest to tell apart.
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
  repoMap: Map<string, Repo>,
  hostLabelById: ReadonlyMap<string, string> | undefined,
  defaultHostId: ExecutionHostId
): Map<string, string> | undefined {
  return getSharedMixedHostContextLabels(worktrees, {
    getHostId: (worktree) =>
      getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId),
    getIdentity: getWorktreeHostIdentity,
    sources: { hostLabelById }
  })
}

export function getHostWorktreeCounts(
  worktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, number> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  const counts = new Map<ExecutionHostId, number>()
  // Dedup by host, not by bare id: the same id on two hosts is two workspaces
  // and has to be counted under each of them (STA-4343).
  const seenIdentities = new Set<string>()
  for (const worktree of worktrees) {
    if (seenIdentities.has(getWorktreeHostIdentity(worktree))) {
      continue
    }
    seenIdentities.add(getWorktreeHostIdentity(worktree))
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1)
  }
  return counts
}

export function getHostWorktreeIds(
  worktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, string[]> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  const idsByHost = new Map<ExecutionHostId, string[]>()
  const seenIdentities = new Set<string>()
  for (const worktree of worktrees) {
    if (seenIdentities.has(getWorktreeHostIdentity(worktree))) {
      continue
    }
    seenIdentities.add(getWorktreeHostIdentity(worktree))
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    const ids = idsByHost.get(hostId) ?? []
    ids.push(worktree.id)
    idsByHost.set(hostId, ids)
  }
  return idsByHost
}

/**
 * Host counts for a lane that may contain folder workspaces as well as worktrees.
 *
 * Why not getHostWorktreeCounts alone: it returns undefined for an empty
 * worktree list, and a header with undefined counts is treated as global. A lane
 * whose only members are folder workspaces would therefore render outside its
 * host section (#15362).
 */
export function getLaneHostWorktreeCounts(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly RenderableFolderWorkspace[],
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, number> | undefined {
  if (worktrees.length === 0 && folderWorkspaces.length === 0) {
    return undefined
  }
  const counts = getHostWorktreeCounts(worktrees, repoMap, defaultHostId) ?? new Map()
  for (const { folderWorkspace, projectGroup } of folderWorkspaces) {
    const hostId = getFolderWorkspaceHostId(folderWorkspace, projectGroup, defaultHostId)
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1)
  }
  return counts
}

/**
 * Host-scoped worktree ids for a lane that may contain folder workspaces.
 *
 * Folder workspaces are not worktrees, so they contribute no ids — but their
 * host must still get an explicit empty array, or the host-section fallbacks
 * treat the missing key as "unscoped" and leak the global worktree ids into
 * that section.
 */
export function getLaneHostWorktreeIds(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly RenderableFolderWorkspace[],
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, string[]> | undefined {
  if (worktrees.length === 0 && folderWorkspaces.length === 0) {
    return undefined
  }
  const idsByHost = getHostWorktreeIds(worktrees, repoMap, defaultHostId) ?? new Map()
  for (const { folderWorkspace, projectGroup } of folderWorkspaces) {
    const hostId = getFolderWorkspaceHostId(folderWorkspace, projectGroup, defaultHostId)
    if (!idsByHost.has(hostId)) {
      idsByHost.set(hostId, [])
    }
  }
  return idsByHost
}
