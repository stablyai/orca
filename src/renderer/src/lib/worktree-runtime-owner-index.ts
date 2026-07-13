import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../shared/types'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId'>
type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
type FolderWorkspaceOwnerRecord = Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>

// Why: owner resolution runs inside retained selectors and interaction paths;
// immutable-slice indexes prevent unrelated store writes from rescanning.
const worktreeOwnerIndexCache = new WeakMap<
  Record<string, readonly WorktreeOwnerRecord[]>,
  ReadonlyMap<string, WorktreeOwnerRecord>
>()
const repoOwnerIndexCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ReadonlyMap<string, RepoOwnerRecord>
>()
const folderWorkspaceOwnerIndexCache = new WeakMap<
  readonly FolderWorkspaceOwnerRecord[],
  ReadonlyMap<string, FolderWorkspaceOwnerRecord>
>()
const projectGroupOwnerIndexCache = new WeakMap<
  readonly ProjectGroupOwnerRecord[],
  ReadonlyMap<string, ProjectGroupOwnerRecord>
>()

function findIndexedOwnerRecord<T extends { id: string }>(
  records: readonly T[] | undefined,
  id: string,
  cache: WeakMap<readonly T[], ReadonlyMap<string, T>>
): T | null {
  if (!records) {
    return null
  }
  let index = cache.get(records)
  if (!index) {
    const next = new Map<string, T>()
    for (const record of records) {
      const recordId = record.id
      if (!next.has(recordId)) {
        // Preserve the prior Array.find behavior for invalid duplicate IDs.
        next.set(recordId, record)
      }
    }
    index = next
    cache.set(records, index)
  }
  return index.get(id) ?? null
}

export function findIndexedWorktreeOwner(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string
): WorktreeOwnerRecord | null {
  if (!worktreesByRepo) {
    return null
  }
  let index = worktreeOwnerIndexCache.get(worktreesByRepo)
  if (!index) {
    const next = new Map<string, WorktreeOwnerRecord>()
    for (const worktrees of Object.values(worktreesByRepo)) {
      for (const worktree of worktrees) {
        const id = worktree.id
        if (!next.has(id)) {
          next.set(id, worktree)
        }
      }
    }
    index = next
    worktreeOwnerIndexCache.set(worktreesByRepo, index)
  }
  return index.get(worktreeId) ?? null
}

export function findIndexedRepoOwner(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string
): RepoOwnerRecord | null {
  return findIndexedOwnerRecord(repos, repoId, repoOwnerIndexCache)
}

export function findIndexedFolderWorkspaceOwner(
  folderWorkspaces: readonly FolderWorkspaceOwnerRecord[] | undefined,
  folderWorkspaceId: string
): FolderWorkspaceOwnerRecord | null {
  return findIndexedOwnerRecord(folderWorkspaces, folderWorkspaceId, folderWorkspaceOwnerIndexCache)
}

export function findIndexedProjectGroupOwner(
  projectGroups: readonly ProjectGroupOwnerRecord[] | undefined,
  projectGroupId: string
): ProjectGroupOwnerRecord | null {
  return findIndexedOwnerRecord(projectGroups, projectGroupId, projectGroupOwnerIndexCache)
}
