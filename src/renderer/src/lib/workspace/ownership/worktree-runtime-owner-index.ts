import {
  buildCatalogOwnerIndex,
  resolveUniqueWorktreeOwnerEntry
} from './workspace-catalog-owner-index'

import './repo-owner-index'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project/groups/project-group-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
type DetectedWorktreeListing = { worktrees: readonly WorktreeOwnerRecord[] }
type FolderWorkspaceOwnerRecord = Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>

type WorktreeOwnerIndex = {
  locationsById: ReadonlyMap<string, ResolvedWorktreeOwnerEntry | ResolvedWorktreeOwnerEntry[]>
  // Callers memoize on result-array identity, so filtered matches must stay stable per (slice, key).
  matchResults: Map<string, readonly WorktreeOwnerRecord[]>
}

type DetectedWorktreeIndex = {
  byId: ReadonlyMap<string, WorktreeOwnerRecord | WorktreeOwnerRecord[]>
  matchResults: Map<string, readonly WorktreeOwnerRecord[]>
}

// Immutable-slice indexes avoid rescans on unrelated writes inside retained selectors and interaction paths.
const worktreeOwnerIndexCache = new WeakMap<
  Record<string, readonly WorktreeOwnerRecord[]>,
  WorktreeOwnerIndex
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
  DetectedWorktreeIndex
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
  if (!worktreesByRepo) {
    return null
  }
  const entry = resolveUniqueWorktreeOwnerEntry(
    getWorktreeOwnerIndex(worktreesByRepo).locationsById.get(worktreeId),
    executionHostId
  )
  return typeof entry === 'string'
    ? null
    : (worktreesByRepo[entry.bucket]?.[entry.position] ?? null)
}

export type IndexedWorktreeOwnerResolution =
  | { kind: 'resolved'; owner: WorktreeOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

// Where the owner is listed, so a typed caller reads its own row back without a cast.
type ResolvedWorktreeOwnerEntry = {
  kind: 'resolved'
  owner: WorktreeOwnerRecord
  bucket: string
  position: number
}
type IndexedWorktreeOwnerEntry = ResolvedWorktreeOwnerEntry | { kind: 'ambiguous' }

const AMBIGUOUS_OWNER_ENTRY: IndexedWorktreeOwnerEntry = { kind: 'ambiguous' }
const MISSING_OWNER_RESOLUTION: IndexedWorktreeOwnerResolution = { kind: 'missing' }

function getWorktreeOwnerIndex(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]>
): WorktreeOwnerIndex {
  let index = worktreeOwnerIndexCache.get(worktreesByRepo)
  if (!index) {
    const locationsById = new Map<
      string,
      ResolvedWorktreeOwnerEntry | ResolvedWorktreeOwnerEntry[]
    >()
    for (const bucket in worktreesByRepo) {
      if (!Object.hasOwn(worktreesByRepo, bucket)) {
        continue
      }
      const worktrees = worktreesByRepo[bucket]
      for (let position = 0; position < worktrees.length; position += 1) {
        const worktree = worktrees[position]
        const id = worktree.id
        const entry: ResolvedWorktreeOwnerEntry = {
          kind: 'resolved',
          owner: worktree,
          bucket,
          position
        }
        const existing = locationsById.get(id)
        if (Array.isArray(existing)) {
          existing.push(entry)
        } else {
          locationsById.set(id, existing ? [existing, entry] : entry)
        }
      }
    }
    index = { locationsById, matchResults: new Map() }
    worktreeOwnerIndexCache.set(worktreesByRepo, index)
  }
  return index
}

export function resolveIndexedWorktreeOwner(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string
): IndexedWorktreeOwnerResolution {
  if (!worktreesByRepo) {
    return MISSING_OWNER_RESOLUTION
  }
  const entry = resolveUniqueWorktreeOwnerEntry(
    getWorktreeOwnerIndex(worktreesByRepo).locationsById.get(worktreeId)
  )
  return entry === 'missing'
    ? MISSING_OWNER_RESOLUTION
    : entry === 'ambiguous'
      ? AMBIGUOUS_OWNER_ENTRY
      : entry
}

/** Every listed row of `worktreeId` in one repo bucket, duplicates kept in catalog order, typed as the caller's catalog. */
export function findIndexedWorktreeRows<W extends WorktreeOwnerRecord>(
  worktreesByRepo: Record<string, readonly W[]> | undefined,
  repoId: string,
  worktreeId: string
): W[] {
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const locations =
    worktreesByRepo && worktreeOwnerIndexCache.get(worktreesByRepo)?.locationsById.get(worktreeId)
  if (!locations) {
    return []
  }
  const entries = Array.isArray(locations) ? locations : [locations]
  return entries.flatMap(({ bucket, position }) => {
    const row = bucket === repoId ? worktreesByRepo?.[bucket]?.[position] : undefined
    return row?.id === worktreeId ? [row] : []
  })
}

function getDetectedWorktreeIndex(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing>
): DetectedWorktreeIndex {
  let index = detectedWorktreeIndexCache.get(detectedWorktreesByRepo)
  if (!index) {
    const next = new Map<string, WorktreeOwnerRecord | WorktreeOwnerRecord[]>()
    for (const listing of Object.values(detectedWorktreesByRepo)) {
      for (const worktree of listing.worktrees) {
        const existing = next.get(worktree.id)
        if (Array.isArray(existing)) {
          existing.push(worktree)
        } else {
          next.set(worktree.id, existing ? [existing, worktree] : worktree)
        }
      }
    }
    index = { byId: next, matchResults: new Map() }
    detectedWorktreeIndexCache.set(detectedWorktreesByRepo, index)
  }
  return index
}

// Callers memoize on result-array identity, so matches must stay stable per (slice, id, host).
function getStableHostMatches(
  results: Map<string, readonly WorktreeOwnerRecord[]>,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  getEntry: () => WorktreeOwnerRecord | WorktreeOwnerRecord[]
): readonly WorktreeOwnerRecord[] {
  const key = catalogOwnerKey(worktreeId, executionHostId)
  const cached = results.get(key)
  if (cached) {
    return cached
  }
  const entry = getEntry()
  const all = Array.isArray(entry) ? entry : [entry]
  const filtered = executionHostId
    ? all.filter((row) => parseExecutionHostId(row.hostId)?.id === executionHostId)
    : all
  const rows = filtered.length > 0 ? filtered : NO_DETECTED_WORKTREES
  results.set(key, rows)
  return rows
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
  const index = getDetectedWorktreeIndex(detectedWorktreesByRepo)
  const entry = index.byId.get(worktreeId)
  return entry
    ? getStableHostMatches(index.matchResults, worktreeId, executionHostId, () => entry)
    : NO_DETECTED_WORKTREES
}

export function hasIndexedDetectedWorktree(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string
): boolean {
  return detectedWorktreesByRepo
    ? getDetectedWorktreeIndex(detectedWorktreesByRepo).byId.has(worktreeId)
    : false
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
  if (!worktreesByRepo) {
    return NO_DETECTED_WORKTREES
  }
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const index = worktreeOwnerIndexCache.get(worktreesByRepo)
  const locations = index?.locationsById.get(worktreeId)
  return index && locations
    ? getStableHostMatches(index.matchResults, worktreeId, executionHostId, () =>
        Array.isArray(locations) ? locations.map((entry) => entry.owner) : locations.owner
      )
    : NO_DETECTED_WORKTREES
}

/** Directory lookups retain first-publication precedence even when owner evidence is ambiguous. */
export function findFirstIndexedWorktree<T extends WorktreeOwnerRecord>(
  worktreesByRepo: Record<string, readonly T[]>,
  worktreeId: string
): T | undefined {
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const locations = worktreeOwnerIndexCache.get(worktreesByRepo)?.locationsById.get(worktreeId)
  const at = Array.isArray(locations) ? locations[0] : locations
  return at ? worktreesByRepo[at.bucket]?.[at.position] : undefined
}
