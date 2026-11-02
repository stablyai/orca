import type { Repo } from '../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

type RepositoryEvidence = {
  position: number | null
  directPosition?: number | null
  hostId: ExecutionHostId | null
}
type RepositoryEvidenceIndex = {
  rows: Map<string, RepositoryEvidence>
  records: Set<RepoOwnerRecord>
}
const repoEvidenceCache = new WeakMap<readonly RepoOwnerRecord[], RepositoryEvidenceIndex>()

function evidenceKey(
  repoId: string,
  hostId?: ExecutionHostId,
  physicalHostId?: ExecutionHostId
): string {
  return JSON.stringify([repoId, hostId ?? null, physicalHostId ?? null])
}

function repositoryEvidence(repos: readonly RepoOwnerRecord[]): RepositoryEvidenceIndex {
  const cached = repoEvidenceCache.get(repos)
  if (cached) {
    return cached
  }
  const rows = new Map<string, RepositoryEvidence>()
  const add = (key: string, position: number, hostId: ExecutionHostId, direct: boolean) => {
    const current = rows.get(key)
    if (!current) {
      rows.set(key, { position, hostId, ...(direct ? { directPosition: position } : {}) })
      return
    }
    current.position = null
    if (current.hostId !== hostId) {
      current.hostId = null
    }
    if (direct) {
      current.directPosition = current.directPosition === undefined ? position : null
    }
  }
  repos.forEach((repo, position) => {
    const hostId = getRepoExecutionHostId(repo)
    const connectionId = getRepoSshConnectionId(repo)
    const physicalHostId = connectionId ? toSshExecutionHostId(connectionId) : hostId
    add(evidenceKey(repo.id), position, hostId, false)
    add(evidenceKey(repo.id, hostId), position, hostId, true)
    if (physicalHostId !== hostId) {
      add(evidenceKey(repo.id, physicalHostId), position, hostId, false)
    }
    add(evidenceKey(repo.id, hostId, physicalHostId), position, hostId, false)
  })
  const index = { rows, records: new Set(repos) }
  repoEvidenceCache.set(repos, index)
  return index
}

/** Keep connection evidence through resolution; implicit SSH recovery prefers the direct repository. */
export function findIndexedReviewRepository<T extends RepoOwnerRecord>(
  repos: readonly T[],
  repoId: string,
  hostId?: ExecutionHostId,
  physicalHostId?: ExecutionHostId
): T | null {
  const evidence = repositoryEvidence(repos).rows.get(evidenceKey(repoId, hostId, physicalHostId))
  const position =
    evidence?.directPosition !== undefined ? evidence.directPosition : evidence?.position
  return position == null ? null : repos[position]
}

/** Host-only downstream APIs must reject records distinguished by nested SSH connection. */
export function hasUniqueIndexedRepositoryHost(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string,
  hostId: ExecutionHostId
): boolean {
  const evidence = repos && repositoryEvidence(repos).rows.get(evidenceKey(repoId, hostId))
  return evidence?.directPosition != null
}

export function hasIndexedRepository(
  repos: readonly RepoOwnerRecord[],
  repository: RepoOwnerRecord
): boolean {
  return repositoryEvidence(repos).records.has(repository)
}

export function resolveIndexedSshRepositoryHost(
  repos: readonly RepoOwnerRecord[],
  repoId: string,
  hostId: ExecutionHostId
): { kind: 'resolved'; hostId: ExecutionHostId } | { kind: 'missing' | 'ambiguous' } {
  const evidence = repositoryEvidence(repos).rows.get(evidenceKey(repoId, hostId))
  return !evidence
    ? { kind: 'missing' }
    : evidence.hostId
      ? { kind: 'resolved', hostId: evidence.hostId }
      : { kind: 'ambiguous' }
}
