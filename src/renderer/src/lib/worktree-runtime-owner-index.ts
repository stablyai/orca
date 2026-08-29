import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
type DetectedWorktreeListing = { worktrees: readonly WorktreeOwnerRecord[] }
type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
type FolderWorkspaceOwnerRecord = Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
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
const detectedWorktreeIndexCache = new WeakMap<
  Record<string, DetectedWorktreeListing>,
  ReadonlyMap<string, readonly WorktreeOwnerRecord[]>
>()

const NO_DETECTED_WORKTREES: readonly WorktreeOwnerRecord[] = []

type IndexedFolderWorkspaceOwnerResolution =
  | { kind: 'resolved'; owner: FolderWorkspaceOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

type IndexedProjectGroupOwnerResolution =
  | { kind: 'resolved'; owner: ProjectGroupOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

export function getCatalogOwnerHostId(owner: {
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
    const hostId = getCatalogOwnerHostId(record)
    const current = next.get(id)
    if (!current) {
      next.set(id, { kind: 'resolved', owner: record })
    } else if (current.kind === 'resolved' && getCatalogOwnerHostId(current.owner) !== hostId) {
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

function addWorktreeOwnerIndexEntry(
  index: Map<string, IndexedWorktreeOwnerResolution>,
  key: string,
  owner: WorktreeOwnerRecord
): void {
  const current = index.get(key)
  if (!current) {
    index.set(key, { kind: 'resolved', owner })
  } else if (
    current.kind === 'resolved' &&
    worktreeOwnerIdentity(current.owner) !== worktreeOwnerIdentity(owner)
  ) {
    index.set(key, { kind: 'ambiguous' })
  }
}

function worktreeOwnerHostIds(owner: WorktreeOwnerRecord): ExecutionHostId[] {
  const physicalHostId = parseExecutionHostId(owner.hostId)?.id
  const runtimeEnvironmentId = owner.runtimeOwnerEnvironmentId?.trim()
  if (!runtimeEnvironmentId) {
    return [physicalHostId ?? 'local']
  }
  const runtimeHostId = toRuntimeExecutionHostId(runtimeEnvironmentId)
  // Why: paired HUB worktrees need logical-runtime lookup without losing their physical SSH route.
  return physicalHostId && physicalHostId !== runtimeHostId
    ? [physicalHostId, runtimeHostId]
    : [runtimeHostId]
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
        addWorktreeOwnerIndexEntry(next, id, worktree)
        for (const hostId of worktreeOwnerHostIds(worktree)) {
          addWorktreeOwnerIndexEntry(next, `${id}\0${hostId}`, worktree)
        }
      }
    }
    index = next
    worktreeOwnerIndexCache.set(worktreesByRepo, index)
  }
  return index.get(worktreeId) ?? { kind: 'missing' }
}

/**
 * Every detected publication of `worktreeId`, in catalog order. Rival repos may publish the same
 * id, so callers that fail closed on conflicts need all matches rather than one resolved owner.
 */
export function findIndexedDetectedWorktrees(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string
): readonly WorktreeOwnerRecord[] {
  if (!detectedWorktreesByRepo) {
    return NO_DETECTED_WORKTREES
  }
  let index = detectedWorktreeIndexCache.get(detectedWorktreesByRepo)
  if (!index) {
    const next = new Map<string, WorktreeOwnerRecord[]>()
    for (const listing of Object.values(detectedWorktreesByRepo)) {
      for (const worktree of listing.worktrees) {
        const matches = next.get(worktree.id)
        if (matches) {
          matches.push(worktree)
        } else {
          next.set(worktree.id, [worktree])
        }
      }
    }
    index = next
    detectedWorktreeIndexCache.set(detectedWorktreesByRepo, index)
  }
  return index.get(worktreeId) ?? NO_DETECTED_WORKTREES
}

export function hasIndexedDetectedWorktree(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string
): boolean {
  return findIndexedDetectedWorktrees(detectedWorktreesByRepo, worktreeId).length > 0
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
