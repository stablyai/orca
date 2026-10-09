import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

type RepoOwnerRecord = Pick<
  Repo,
  'id' | 'connectionId' | 'executionHostId' | 'catalogOwnerHostId' | 'authoritativeExecutionHostId'
>

const repoOwnerIndexCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ReadonlyMap<string, IndexedRepoOwnerResolution>
>()

export type IndexedRepoOwnerResolution =
  | { kind: 'resolved'; owner: RepoOwnerRecord; candidates: readonly RepoOwnerRecord[] }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: readonly RepoOwnerRecord[] }

type RepoOwnerIndexEntry = Exclude<IndexedRepoOwnerResolution, { kind: 'missing' }> & {
  candidates: RepoOwnerRecord[]
}

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
    const next = new Map<string, RepoOwnerIndexEntry>()
    for (const repo of repos) {
      const repoId = repo.id
      const current = next.get(repoId)
      if (!current) {
        next.set(repoId, { kind: 'resolved', owner: repo, candidates: [repo] })
      } else {
        current.candidates.push(repo)
        if (
          current.kind === 'resolved' &&
          repoOwnerIdentity(current.owner) !== repoOwnerIdentity(repo)
        ) {
          next.set(repoId, { kind: 'ambiguous', candidates: current.candidates })
        }
      }
      next.set(`${repoId}\0${getRepoExecutionHostId(repo)}`, {
        kind: 'resolved',
        owner: repo,
        candidates: [repo]
      })
    }
    index = next
    repoOwnerIndexCache.set(repos, index)
  }
  return index.get(repoId) ?? { kind: 'missing' }
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The cache retains the original rows from this immutable T-valued array.
  return resolution?.kind === 'resolved' ? (resolution.owner as T) : null
}

export function findIndexedReposById<T extends RepoOwnerRecord>(
  repos: readonly T[] | undefined,
  repoId: string
): readonly T[] {
  const resolution = resolveIndexedRepoOwner(repos, repoId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The cache retains the original rows from this immutable T-valued array.
  return (resolution.kind === 'missing' ? [] : resolution.candidates) as readonly T[]
}
