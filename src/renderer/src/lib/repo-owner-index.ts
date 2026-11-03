import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  createRepoExecutionHostLookup,
  type ExecutionHostOwnerLookup
} from '../../../shared/worktree-execution-host-resolution'

type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
const EMPTY_ROWS: readonly RepoOwnerRecord[] = []
const EMPTY_EXECUTION_HOST_LOOKUP = createRepoExecutionHostLookup(() => EMPTY_ROWS)
const repoExecutionHostLookupCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ExecutionHostOwnerLookup<RepoOwnerRecord>
>()

const repoOwnerIndexCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ReadonlyMap<string, IndexedRepoOwnerResolution>
>()
const qualifiedRepoOwnerIndexCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ReadonlyMap<string, IndexedRepoOwnerResolution>
>()
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
    const qualified = new Map<string, IndexedRepoOwnerResolution>()
    const rowsById = new Map<string, RepoOwnerRecord[]>()
    for (const repo of repos) {
      const repoId = repo.id
      const rows = rowsById.get(repoId)
      if (rows) {
        rows.push(repo)
      } else {
        rowsById.set(repoId, [repo])
      }
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
      const key = `${repoId}\0${getRepoExecutionHostId(repo)}`
      const prior = qualified.get(key)
      qualified.set(
        key,
        prior &&
          (prior.kind !== 'resolved' ||
            (prior.owner.connectionId?.trim() || null) !== (repo.connectionId?.trim() || null))
          ? { kind: 'ambiguous' }
          : { kind: 'resolved', owner: repo }
      )
      qualified.set(`${key}\0${repo.connectionId?.trim() || ''}`, { kind: 'resolved', owner: repo })
    }
    index = next
    repoOwnerIndexCache.set(repos, index)
    qualifiedRepoOwnerIndexCache.set(repos, qualified)
    repoExecutionHostLookupCache.set(
      repos,
      createRepoExecutionHostLookup((id) => rowsById.get(id) ?? EMPTY_ROWS)
    )
  }
  return index.get(repoId) ?? { kind: 'missing' }
}

export function getIndexedRepoExecutionHostLookup(
  repos: readonly RepoOwnerRecord[] | undefined
): ExecutionHostOwnerLookup<RepoOwnerRecord> {
  if (!repos) {
    return EMPTY_EXECUTION_HOST_LOOKUP
  }
  resolveIndexedRepoOwner(repos, '')
  return repoExecutionHostLookupCache.get(repos) ?? EMPTY_EXECUTION_HOST_LOOKUP
}

export function resolveQualifiedIndexedRepoOwnerForHost(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string,
  hostId: ExecutionHostId,
  connectionId?: string | null
): IndexedRepoOwnerResolution {
  if (!repos) {
    return { kind: 'missing' }
  }
  resolveIndexedRepoOwner(repos, repoId)
  const key = `${repoId}\0${hostId}${connectionId === undefined ? '' : `\0${connectionId ?? ''}`}`
  return qualifiedRepoOwnerIndexCache.get(repos)?.get(key) ?? { kind: 'missing' }
}

export function findIndexedRepoOwner(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string
): RepoOwnerRecord | null {
  const resolution = resolveIndexedRepoOwner(repos, repoId)
  return resolution.kind === 'resolved' ? resolution.owner : null
}

export function findIndexedRepoOwnerForHost<T extends RepoOwnerRecord>(
  repos: readonly T[] | undefined,
  repoId: string,
  executionHostId: ExecutionHostId
): T | null {
  if (!repos) {
    return null
  }
  resolveIndexedRepoOwner(repos, repoId)
  const resolution = repoOwnerIndexCache.get(repos)?.get(`${repoId}\0${executionHostId}`)
  // The cache is keyed by this exact array, so its owner retains the caller's row type.
  return resolution?.kind === 'resolved' ? (resolution.owner as T) : null
}
