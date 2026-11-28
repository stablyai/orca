import type { Worktree } from '../../worktree/types'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../execution-host/execution-host'
import type { RepoOfWorktree } from '../row-types'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'

function createRawHostDeduper(firstRawHost: string): (worktree: Worktree) => boolean {
  const firstSeenIds = new Set<string>()
  let seenByRawHost: Map<string, Set<string>> | undefined
  return (worktree: Worktree) => {
    const rawHost = worktree.hostId ?? ''
    if (rawHost === firstRawHost) {
      if (firstSeenIds.has(worktree.id)) {
        return false
      }
      firstSeenIds.add(worktree.id)
      return true
    }
    seenByRawHost ??= new Map([[firstRawHost, firstSeenIds]])
    let seenIds = seenByRawHost.get(rawHost)
    if (!seenIds) {
      seenIds = new Set()
      seenByRawHost.set(rawHost, seenIds)
    } else if (seenIds.has(worktree.id)) {
      return false
    }
    seenIds.add(worktree.id)
    return true
  }
}

export function getHostWorktreeCounts(
  worktrees: readonly Worktree[],
  repoOf: RepoOfWorktree,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, number> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  if (worktrees.length === 1) {
    const worktree = worktrees[0]
    return new Map([[getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId), 1]])
  }
  // Same-ID workspaces on two hosts count under each host (STA-4343).
  const counts = new Map<ExecutionHostId, number>()
  const markUnique = createRawHostDeduper(worktrees[0].hostId ?? '')
  for (const worktree of worktrees) {
    if (!markUnique(worktree)) {
      continue
    }
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
  if (worktrees.length === 1) {
    const worktree = worktrees[0]
    return new Map([
      [getWorktreeExecutionHostId(worktree, repoOf(worktree), defaultHostId), [worktree.id]]
    ])
  }
  const idsByHost = new Map<ExecutionHostId, string[]>()
  const markUnique = createRawHostDeduper(worktrees[0].hostId ?? '')
  for (const worktree of worktrees) {
    if (!markUnique(worktree)) {
      continue
    }
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
