import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../shared/types'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId'>
type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> &
  Partial<Pick<Repo, 'path'>>
type FolderWorkspaceOwnerRecord = Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>

// Why: owner resolution runs inside retained selectors and interaction paths;
// immutable-slice indexes prevent unrelated store writes from rescanning.
const worktreeOwnerIndexCache = new WeakMap<
  Record<string, readonly WorktreeOwnerRecord[]>,
  ReadonlyMap<string, WorktreeOwnerRecord>
>()
// Why: a project shared across hosts has several repo records under one id, so
// the repo index groups every record per id (built once per immutable array).
const repoOwnerIndexCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ReadonlyMap<string, readonly RepoOwnerRecord[]>
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

function getRepoOwnerIndex(
  repos: readonly RepoOwnerRecord[]
): ReadonlyMap<string, readonly RepoOwnerRecord[]> {
  let index = repoOwnerIndexCache.get(repos)
  if (!index) {
    const next = new Map<string, RepoOwnerRecord[]>()
    for (const record of repos) {
      const recordId = record.id
      const existing = next.get(recordId)
      if (existing) {
        existing.push(record)
      } else {
        next.set(recordId, [record])
      }
    }
    index = next
    repoOwnerIndexCache.set(repos, index)
  }
  return index
}

export function findIndexedRepoOwners(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string
): readonly RepoOwnerRecord[] {
  if (!repos) {
    return []
  }
  // The first entry preserves the prior Array.find "first matching id" behavior.
  return getRepoOwnerIndex(repos).get(repoId) ?? []
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
