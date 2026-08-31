import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  getRawWorktreeIdFromWorkspaceSessionKey,
  parseWorkspaceKey
} from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
export {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  getCatalogOwnerHostId
} from './worktree-catalog-owner-index'

type WorktreeOwnerRecord = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'
> &
  Partial<Pick<Worktree, 'path'>>
type DetectedWorktreeListing = { worktrees: readonly WorktreeOwnerRecord[] }
type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
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
const detectedWorktreeIndexCache = new WeakMap<
  Record<string, DetectedWorktreeListing>,
  ReadonlyMap<string, readonly WorktreeOwnerRecord[]>
>()

const NO_DETECTED_WORKTREES: readonly WorktreeOwnerRecord[] = []

/**
 * Owner indexes are keyed by the durable raw `repo::path` id. Session maps may
 * hand us a canonical `worktree:<id>` key, so unwrap it at this boundary.
 * Scoped keys that do not contain a complete worktree id are malformed and
 * must not fall through to a repo-id lookup.
 */
export function normalizeWorktreeLookupId(worktreeId: string): string | null {
  const scope = parseWorkspaceKey(worktreeId)
  const rawWorktreeId = getRawWorktreeIdFromWorkspaceSessionKey(worktreeId)
  if (rawWorktreeId === null) {
    return null
  }
  if (scope?.type === 'worktree') {
    const parsed = splitWorktreeId(rawWorktreeId)
    if (!parsed?.repoId || !parsed.worktreePath) {
      return null
    }
  }
  return rawWorktreeId
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
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return null
  }
  resolveIndexedWorktreeOwner(worktreesByRepo, rawWorktreeId)
  const resolution = worktreeOwnerIndexCache
    .get(worktreesByRepo)
    ?.get(`${rawWorktreeId}\0${executionHostId}`)
  return resolution?.kind === 'resolved' ? resolution.owner : null
}

export type IndexedRepoOwnerResolution =
  | { kind: 'resolved'; owner: RepoOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

function repoOwnerIdentity(owner: RepoOwnerRecord): string {
  const parsedConnection = parseExecutionHostId(owner.connectionId)
  const connectionId =
    parsedConnection?.kind === 'ssh'
      ? parsedConnection.targetId
      : owner.connectionId?.trim() || null
  // Mixed-version catalogs may omit executionHostId on one row while another
  // derives the equivalent SSH host from connectionId. Compare the normalized
  // host/connection tuple so equivalent publications do not become ambiguous.
  return JSON.stringify([getRepoExecutionHostId({ ...owner, connectionId }), connectionId])
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
  const parsedHost = parseExecutionHostId(owner.hostId)
  const runtimeEnvironmentId =
    owner.runtimeOwnerEnvironmentId?.trim() ||
    (parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null)
  const physicalHostId =
    parsedHost?.kind === 'runtime'
      ? null
      : (parsedHost?.id ?? (runtimeEnvironmentId ? null : 'local'))
  return JSON.stringify([owner.repoId, physicalHostId, runtimeEnvironmentId])
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
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
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
  return index.get(rawWorktreeId) ?? { kind: 'missing' }
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
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
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
  return index.get(rawWorktreeId) ?? NO_DETECTED_WORKTREES
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
