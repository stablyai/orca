import {
  buildCatalogOwnerIndex,
  worktreeOwnerIdentity,
  worktreeOwnerHostIds
} from './workspace-catalog-owner-index'
export { getCatalogOwnerHostId, worktreeOwnerHostIds } from './workspace-catalog-owner-index'
export {
  findIndexedRepoOwner,
  findIndexedRepoOwnerForHost,
  resolveIndexedRepoOwner,
  resolveQualifiedIndexedRepoOwnerForHost,
  type IndexedRepoOwnerResolution
} from './repo-owner-index'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
type DetectedWorktreeListing = { worktrees: readonly WorktreeOwnerRecord[] }
type FolderWorkspaceOwnerRecord = Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>

// Immutable-slice indexes avoid rescans on unrelated writes inside retained selectors and interaction paths.
const worktreeOwnerIndexCache = new WeakMap<
  Record<string, readonly WorktreeOwnerRecord[]>,
  {
    owners: ReadonlyMap<string, IndexedWorktreeOwnerEntry>
    matches: ReadonlyMap<string, readonly WorktreeOwnerRecord[]>
    first: ReadonlyMap<string, { bucket: string; position: number }>
  }
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

export function findIndexedWorktreeOwner(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string
): WorktreeOwnerRecord | null {
  const resolution = resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  return resolution.kind === 'resolved' ? resolution.owner : null
}

/** Returns the caller's own row type: the index records where the owner is listed. */
export function findIndexedWorktreeOwnerForHost<T extends WorktreeOwnerRecord>(
  worktreesByRepo: Record<string, readonly T[]> | undefined,
  worktreeId: string,
  executionHostId: ExecutionHostId
): T | null {
  const hostKey = `${worktreeId}\0${executionHostId}`
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const entry = worktreesByRepo && worktreeOwnerIndexCache.get(worktreesByRepo)?.owners.get(hostKey)
  const row = entry?.kind === 'resolved' ? worktreesByRepo?.[entry.bucket]?.[entry.position] : null
  return row ?? null
}

export type IndexedWorktreeOwnerResolution =
  | { kind: 'resolved'; owner: WorktreeOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

// Where the owner is listed, so a typed caller reads its own row back without a cast.
type IndexedWorktreeOwnerEntry =
  | { kind: 'resolved'; owner: WorktreeOwnerRecord; bucket: string; position: number }
  | { kind: 'ambiguous' }

function addWorktreeOwnerIndexEntry(
  index: Map<string, IndexedWorktreeOwnerEntry>,
  key: string,
  owner: WorktreeOwnerRecord,
  at: { bucket: string; position: number }
): void {
  const current = index.get(key)
  if (!current) {
    index.set(key, { kind: 'resolved', owner, ...at })
  } else if (
    current.kind === 'resolved' &&
    worktreeOwnerIdentity(current.owner) !== worktreeOwnerIdentity(owner)
  ) {
    index.set(key, { kind: 'ambiguous' })
  }
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
    const next = new Map<string, IndexedWorktreeOwnerEntry>()
    const matches = new Map<string, WorktreeOwnerRecord[]>()
    const first = new Map<string, { bucket: string; position: number }>()
    for (const [bucket, worktrees] of Object.entries(worktreesByRepo)) {
      worktrees.forEach((worktree, position) => {
        const id = worktree.id
        if (!matches.has(id)) {
          first.set(id, { bucket, position })
        }
        addMatchingWorktree(matches, id, worktree)
        addWorktreeOwnerIndexEntry(next, id, worktree, { bucket, position })
        for (const hostId of worktreeOwnerHostIds(worktree)) {
          addWorktreeOwnerIndexEntry(next, `${id}\0${hostId}`, worktree, { bucket, position })
        }
      })
    }
    index = { owners: next, matches, first }
    worktreeOwnerIndexCache.set(worktreesByRepo, index)
  }
  return index.owners.get(worktreeId) ?? { kind: 'missing' }
}

/**
 * Every detected publication of `worktreeId`, in catalog order. Rival repos may publish the same
 * id, so callers that fail closed on conflicts need all matches rather than one resolved owner.
 */
export function findIndexedDetectedWorktrees(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): readonly WorktreeOwnerRecord[] {
  if (!detectedWorktreesByRepo) {
    return NO_DETECTED_WORKTREES
  }
  let index = detectedWorktreeIndexCache.get(detectedWorktreesByRepo)
  if (!index) {
    const next = new Map<string, WorktreeOwnerRecord[]>()
    for (const listing of Object.values(detectedWorktreesByRepo)) {
      for (const worktree of listing.worktrees) {
        addMatchingWorktree(next, worktree.id, worktree)
      }
    }
    index = next
    detectedWorktreeIndexCache.set(detectedWorktreesByRepo, index)
  }
  return index.get(catalogOwnerKey(worktreeId, executionHostId)) ?? NO_DETECTED_WORKTREES
}

export function hasIndexedDetectedWorktree(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string
): boolean {
  return findIndexedDetectedWorktrees(detectedWorktreesByRepo, worktreeId).length > 0
}

function catalogOwnerKey(id: string, executionHostId?: ExecutionHostId): string {
  return executionHostId ? `${id}\0${executionHostId}` : id
}

/** An unqualified lookup keeps a twin (same id on two hosts) distinct from a missing row. */
export function resolveIndexedFolderWorkspaceOwner(
  folderWorkspaces: readonly FolderWorkspaceOwnerRecord[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): IndexedFolderWorkspaceOwnerResolution {
  if (!folderWorkspaces) {
    return { kind: 'missing' }
  }
  let index = folderWorkspaceOwnerIndexCache.get(folderWorkspaces)
  if (!index) {
    index = buildCatalogOwnerIndex(folderWorkspaces)
    folderWorkspaceOwnerIndexCache.set(folderWorkspaces, index)
  }
  return index.get(catalogOwnerKey(folderWorkspaceId, executionHostId)) ?? { kind: 'missing' }
}

/** An unqualified lookup keeps a twin (same id on two hosts) distinct from a missing row. */
export function resolveIndexedProjectGroupOwner(
  projectGroups: readonly ProjectGroupOwnerRecord[] | undefined,
  projectGroupId: string,
  executionHostId?: ExecutionHostId
): IndexedProjectGroupOwnerResolution {
  if (!projectGroups) {
    return { kind: 'missing' }
  }
  let index = projectGroupOwnerIndexCache.get(projectGroups)
  if (!index) {
    index = buildCatalogOwnerIndex(projectGroups)
    projectGroupOwnerIndexCache.set(projectGroups, index)
  }
  return index.get(catalogOwnerKey(projectGroupId, executionHostId)) ?? { kind: 'missing' }
}

export function findIndexedFolderWorkspaceOwner<T extends FolderWorkspaceOwnerRecord>(
  folderWorkspaces: readonly T[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): T | null {
  const resolution = resolveIndexedFolderWorkspaceOwner(
    folderWorkspaces,
    folderWorkspaceId,
    executionHostId
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the index is built from and cached on this exact array, so its owner is one of the caller's T rows.
  return resolution.kind === 'resolved' ? (resolution.owner as T) : null
}

export function findIndexedProjectGroupOwner<T extends ProjectGroupOwnerRecord>(
  projectGroups: readonly T[] | undefined,
  projectGroupId: string,
  executionHostId?: ExecutionHostId
): T | null {
  const resolution = resolveIndexedProjectGroupOwner(projectGroups, projectGroupId, executionHostId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the index is built from and cached on this exact array, so its owner is one of the caller's T rows.
  return resolution.kind === 'resolved' ? (resolution.owner as T) : null
}

/** All known publications in catalog order, including rival owners of the same id. */
export function findIndexedWorktrees(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): readonly WorktreeOwnerRecord[] {
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  return (
    (worktreesByRepo &&
      worktreeOwnerIndexCache
        .get(worktreesByRepo)
        ?.matches.get(catalogOwnerKey(worktreeId, executionHostId))) ??
    NO_DETECTED_WORKTREES
  )
}

/** Directory lookups retain first-publication precedence even when owner evidence is ambiguous. */
export function findFirstIndexedWorktree<T extends WorktreeOwnerRecord>(
  worktreesByRepo: Record<string, readonly T[]>,
  worktreeId: string
): T | undefined {
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const at = worktreeOwnerIndexCache.get(worktreesByRepo)?.first.get(worktreeId)
  return at ? worktreesByRepo[at.bucket]?.[at.position] : undefined
}

function addMatchingWorktree(
  index: Map<string, WorktreeOwnerRecord[]>,
  id: string,
  row: WorktreeOwnerRecord
): void {
  const hostId = parseExecutionHostId(row.hostId)?.id
  for (const key of hostId ? [id, catalogOwnerKey(id, hostId)] : [id]) {
    const rows = index.get(key)
    if (rows) {
      rows.push(row)
    } else {
      index.set(key, [row])
    }
  }
}
