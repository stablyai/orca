import type { Worktree } from '../../worktree/types'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../execution-host/execution-host'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import type { RepoOfWorktree } from '../row-types'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'

export function getHostWorktreeCounts(
  worktrees: readonly Worktree[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, number> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  // Same-ID workspaces on two hosts count under each host (STA-4343).
  const counts = new Map<ExecutionHostId, number>()
  const seenIdentities = new Set<string>()
  for (const worktree of worktrees) {
    const identity = getWorktreeHostIdentity(worktree)
    if (seenIdentities.has(identity)) {
      continue
    }
    seenIdentities.add(identity)
    const hostId = getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId)
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1)
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
    const ids = idsByHost.get(hostId)
    if (ids) {
      ids.push(worktree.id)
    } else {
      idsByHost.set(hostId, [worktree.id])
    }
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
  return getLaneHostWorktreeScope(worktrees, folderWorkspaces, repoOf, defaultHostId)
    .hostWorktreeIds
}

/** Computes lane host counts and IDs in one worktree walk so callers avoid deduping twice per lane. */
export function getLaneHostWorktreeScope(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly RenderableFolderWorkspace[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId
): {
  hostWorktreeCounts: Map<ExecutionHostId, number> | undefined
  hostWorktreeIds: Map<ExecutionHostId, string[]> | undefined
} {
  if (worktrees.length === 0 && folderWorkspaces.length === 0) {
    return { hostWorktreeCounts: undefined, hostWorktreeIds: undefined }
  }
  const idsByHost = getHostWorktreeIds(worktrees, repoOf, defaultHostId) ?? new Map()
  const counts = new Map<ExecutionHostId, number>()
  for (const [hostId, ids] of idsByHost) {
    counts.set(hostId, ids.length)
  }
  for (const { folderWorkspace, projectGroup } of folderWorkspaces) {
    const hostId = getFolderWorkspaceHostId(folderWorkspace, projectGroup, defaultHostId)
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1)
    if (!idsByHost.has(hostId)) {
      idsByHost.set(hostId, [])
    }
  }
  return { hostWorktreeCounts: counts, hostWorktreeIds: idsByHost }
}
