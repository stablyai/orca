export {
  findIndexedRepoOwner,
  findIndexedRepoOwnerForHost,
  resolveIndexedRepoOwner,
  findIndexedReposById,
  type IndexedRepoOwnerResolution
} from './repo-runtime-owner-index'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

type WorktreeOwnerRecord = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId' | 'identity' | 'instanceId'
>
type DetectedWorktreeListing = { worktrees: readonly WorktreeOwnerRecord[] }
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
  return getRepoExecutionHostId(owner)
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
  const resolution = resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId, executionHostId)
  return resolution.kind === 'resolved' ? resolution.owner : null
}

export type IndexedWorktreeOwnerResolution =
  | { kind: 'resolved'; owner: WorktreeOwnerRecord; candidates?: readonly WorktreeOwnerRecord[] }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates?: readonly WorktreeOwnerRecord[] }

function worktreeOwnerIdentity(owner: WorktreeOwnerRecord): string {
  return JSON.stringify([
    owner.repoId,
    owner.hostId ?? null,
    owner.runtimeOwnerEnvironmentId?.trim() || null,
    owner.identity?.executionHostId ?? null,
    owner.identity?.instanceId ?? owner.instanceId ?? null
  ])
}

function addWorktreeOwnerIndexEntry(
  index: Map<string, WorktreeOwnerIndexEntry>,
  key: string,
  owner: WorktreeOwnerRecord
): void {
  const current = index.get(key)
  if (!current) {
    index.set(key, { kind: 'resolved', owner, candidates: [owner] })
    return
  }
  current.candidates.push(owner)
  if (
    current.kind === 'resolved' &&
    worktreeOwnerIdentity(current.owner) !== worktreeOwnerIdentity(owner)
  ) {
    index.set(key, { kind: 'ambiguous', candidates: current.candidates })
  }
}

type WorktreeOwnerIndexEntry = Exclude<IndexedWorktreeOwnerResolution, { kind: 'missing' }> & {
  candidates: WorktreeOwnerRecord[]
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
  worktreeId: string,
  executionHostId?: ExecutionHostId
): IndexedWorktreeOwnerResolution {
  if (!worktreesByRepo) {
    return { kind: 'missing' }
  }
  let index = worktreeOwnerIndexCache.get(worktreesByRepo)
  if (!index) {
    const next = new Map<string, WorktreeOwnerIndexEntry>()
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
  return (
    index.get(executionHostId ? `${worktreeId}\0${executionHostId}` : worktreeId) ?? {
      kind: 'missing'
    }
  )
}

/**
 * Every detected publication of `worktreeId`, in catalog order. Rival repos may publish the same
 * id, so callers that fail closed on conflicts need all matches rather than one resolved owner.
 */
export function findIndexedDetectedWorktrees<T extends Record<string, DetectedWorktreeListing>>(
  detectedWorktreesByRepo: T | undefined,
  worktreeId: string
): readonly T[string]['worktrees'][number][] {
  if (!detectedWorktreesByRepo) {
    return []
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The index retains the original rows from this immutable T-valued snapshot.
  return (index.get(worktreeId) ??
    NO_DETECTED_WORKTREES) as readonly T[string]['worktrees'][number][]
}

export function findIndexedWorktreesById<T extends Record<string, readonly WorktreeOwnerRecord[]>>(
  worktreesByRepo: T | undefined,
  worktreeId: string
): readonly T[string][number][] {
  const result = resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Candidate rows are retained directly from this immutable T-valued snapshot.
  return (
    result.kind === 'missing' ? [] : (result.candidates ?? [])
  ) as readonly T[string][number][]
}

export function hasIndexedDetectedWorktree(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string
): boolean {
  return findIndexedDetectedWorktrees(detectedWorktreesByRepo, worktreeId).length > 0
}

export function findIndexedFolderWorkspaceOwner<T extends FolderWorkspaceOwnerRecord>(
  folderWorkspaces: readonly T[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): T | null {
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
  // The cache is keyed by this exact array, so its owner retains the caller's row type.
  return resolution?.kind === 'resolved' ? (resolution.owner as T) : null
}

export function findIndexedProjectGroupOwner<T extends ProjectGroupOwnerRecord>(
  projectGroups: readonly T[] | undefined,
  projectGroupId: string,
  executionHostId?: ExecutionHostId
): T | null {
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
  // The cache is keyed by this exact array, so its owner retains the caller's row type.
  return resolution?.kind === 'resolved' ? (resolution.owner as T) : null
}
