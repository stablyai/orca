import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../shared/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
type FolderWorkspaceOwnerRecord = Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId'
>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>

// Why: owner resolution runs inside retained selectors and interaction paths;
// immutable-slice indexes prevent unrelated store writes from rescanning.
const worktreeOwnerIndexCache = new WeakMap<
  Record<string, readonly WorktreeOwnerRecord[]>,
  ReadonlyMap<string, IndexedWorktreeOwnerResolution>
>()
const repoOwnerIndexCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ReadonlyMap<string, IndexedRepoOwnerResolution>
>()
const folderWorkspaceOwnerIndexCache = new WeakMap<
  readonly FolderWorkspaceOwnerRecord[],
  ReadonlyMap<string, IndexedFolderWorkspaceOwnerResolution>
>()
const projectGroupOwnerIndexCache = new WeakMap<
  readonly ProjectGroupOwnerRecord[],
  ReadonlyMap<string, IndexedProjectGroupOwnerResolution>
>()

type IndexedFolderWorkspaceOwnerResolution =
  | { kind: 'resolved'; owner: FolderWorkspaceOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

type IndexedProjectGroupOwnerResolution =
  | { kind: 'resolved'; owner: ProjectGroupOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

function catalogOwnerHostId(owner: {
  connectionId?: string | null
  executionHostId?: string | null
}): ExecutionHostId {
  const explicitHost = parseExecutionHostId(owner.executionHostId)
  if (explicitHost) {
    return explicitHost.id
  }
  const connectionId = owner.connectionId?.trim()
  return connectionId ? toSshExecutionHostId(connectionId) : 'local'
}

function buildCatalogOwnerIndex<
  T extends { id: string; connectionId?: string | null; executionHostId?: string | null }
>(
  records: readonly T[]
): ReadonlyMap<string, { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }> {
  const next = new Map<string, { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }>()
  for (const record of records) {
    const id = record.id
    const hostId = catalogOwnerHostId(record)
    const current = next.get(id)
    if (!current) {
      next.set(id, { kind: 'resolved', owner: record })
    } else if (current.kind === 'resolved' && catalogOwnerHostId(current.owner) !== hostId) {
      next.set(id, { kind: 'ambiguous' })
    }
    next.set(`${id}\0${hostId}`, {
      kind: 'resolved',
      owner: record
    })
  }
  return next
}

export function findIndexedWorktreeOwner(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string
): WorktreeOwnerRecord | null {
  const resolution = resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  return resolution.kind === 'resolved' ? resolution.owner : null
}

export function findIndexedWorktreeOwnerForHost(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOwnerRecord | null {
  if (!worktreesByRepo) {
    return null
  }
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const resolution = worktreeOwnerIndexCache
    .get(worktreesByRepo)
    ?.get(`${worktreeId}\0${executionHostId}`)
  return resolution?.kind === 'resolved' ? resolution.owner : null
}

export type IndexedRepoOwnerResolution =
  | { kind: 'resolved'; owner: RepoOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

function repoOwnerIdentity(owner: RepoOwnerRecord): string {
  return JSON.stringify([owner.executionHostId ?? null, owner.connectionId?.trim() || null])
}

export function resolveIndexedRepoOwner(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string
): IndexedRepoOwnerResolution {
  if (!repos) {
    return { kind: 'missing' }
  }
  let index = repoOwnerIndexCache.get(repos)
  if (!index) {
    const next = new Map<string, IndexedRepoOwnerResolution>()
    for (const repo of repos) {
      const repoId = repo.id
      const current = next.get(repoId)
      if (!current) {
        next.set(repoId, { kind: 'resolved', owner: repo })
      } else if (
        current.kind === 'resolved' &&
        repoOwnerIdentity(current.owner) !== repoOwnerIdentity(repo)
      ) {
        next.set(repoId, { kind: 'ambiguous' })
      }
      next.set(`${repoId}\0${getRepoExecutionHostId(repo)}`, {
        kind: 'resolved',
        owner: repo
      })
    }
    index = next
    repoOwnerIndexCache.set(repos, index)
  }
  return index.get(repoId) ?? { kind: 'missing' }
}

export type IndexedWorktreeOwnerResolution =
  | { kind: 'resolved'; owner: WorktreeOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

function worktreeOwnerIdentity(owner: WorktreeOwnerRecord): string {
  return JSON.stringify([
    owner.repoId,
    owner.hostId ?? null,
    owner.runtimeOwnerEnvironmentId?.trim() || null
  ])
}

function worktreeOwnerHostId(owner: WorktreeOwnerRecord): ExecutionHostId {
  return (
    parseExecutionHostId(owner.hostId)?.id ??
    (owner.runtimeOwnerEnvironmentId
      ? toRuntimeExecutionHostId(owner.runtimeOwnerEnvironmentId)
      : 'local')
  )
}

export function resolveIndexedWorktreeOwner(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string
): IndexedWorktreeOwnerResolution {
  if (!worktreesByRepo) {
    return { kind: 'missing' }
  }
  let index = worktreeOwnerIndexCache.get(worktreesByRepo)
  if (!index) {
    const next = new Map<string, IndexedWorktreeOwnerResolution>()
    for (const worktrees of Object.values(worktreesByRepo)) {
      for (const worktree of worktrees) {
        const id = worktree.id
        const current = next.get(id)
        if (!current) {
          next.set(id, { kind: 'resolved', owner: worktree })
        } else if (
          current.kind === 'resolved' &&
          worktreeOwnerIdentity(current.owner) !== worktreeOwnerIdentity(worktree)
        ) {
          next.set(id, { kind: 'ambiguous' })
        }
        next.set(`${id}\0${worktreeOwnerHostId(worktree)}`, {
          kind: 'resolved',
          owner: worktree
        })
      }
    }
    index = next
    worktreeOwnerIndexCache.set(worktreesByRepo, index)
  }
  return index.get(worktreeId) ?? { kind: 'missing' }
}

export function findIndexedRepoOwner(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string
): RepoOwnerRecord | null {
  const resolution = resolveIndexedRepoOwner(repos, repoId)
  return resolution.kind === 'resolved' ? resolution.owner : null
}

export function findIndexedRepoOwnerForHost(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string,
  executionHostId: ExecutionHostId
): RepoOwnerRecord | null {
  if (!repos) {
    return null
  }
  resolveIndexedRepoOwner(repos, repoId)
  const resolution = repoOwnerIndexCache.get(repos)?.get(`${repoId}\0${executionHostId}`)
  return resolution?.kind === 'resolved' ? resolution.owner : null
}

export function findIndexedFolderWorkspaceOwner(
  folderWorkspaces: readonly FolderWorkspaceOwnerRecord[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): FolderWorkspaceOwnerRecord | null {
  if (!folderWorkspaces) {
    return null
  }
  let index = folderWorkspaceOwnerIndexCache.get(folderWorkspaces)
  if (!index) {
    index = buildCatalogOwnerIndex(folderWorkspaces)
    folderWorkspaceOwnerIndexCache.set(folderWorkspaces, index)
  }
  const resolution = index.get(
    executionHostId ? `${folderWorkspaceId}\0${executionHostId}` : folderWorkspaceId
  )
  return resolution?.kind === 'resolved' ? resolution.owner : null
}

export function findIndexedProjectGroupOwner(
  projectGroups: readonly ProjectGroupOwnerRecord[] | undefined,
  projectGroupId: string,
  executionHostId?: ExecutionHostId
): ProjectGroupOwnerRecord | null {
  if (!projectGroups) {
    return null
  }
  let index = projectGroupOwnerIndexCache.get(projectGroups)
  if (!index) {
    index = buildCatalogOwnerIndex(projectGroups)
    projectGroupOwnerIndexCache.set(projectGroups, index)
  }
  const resolution = index.get(
    executionHostId ? `${projectGroupId}\0${executionHostId}` : projectGroupId
  )
  return resolution?.kind === 'resolved' ? resolution.owner : null
}
