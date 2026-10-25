import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'

type IndexedRepo = {
  index: number
  repo: Repo
}

export type GitHubRepoLookupIndex = {
  findById: (repoId: string) => Repo | undefined
  findByPath: (repoPath: string) => Repo | undefined
  findByIdOrPath: (repoId: string | undefined, repoPath: string) => Repo | undefined
  /** The row for `repoPath` on `hostId`, preferring the caller's `repoId`. */
  findOnHost: (hostId: string, repoId: string | undefined, repoPath: string) => Repo | undefined
}

function idAndPathKey(repoId: string, repoPath: string): string {
  return `${repoId}\u0000${repoPath}`
}

// Why: repo identity/path updates replace this array, while weak ownership avoids retaining superseded snapshots.
const lookupByRepos = new WeakMap<readonly Repo[], GitHubRepoLookupIndex>()
const EMPTY_REPOS: readonly Repo[] = []

export function getGitHubRepoLookupIndex(
  repos: readonly Repo[] | undefined
): GitHubRepoLookupIndex {
  const repoRows = repos ?? EMPTY_REPOS
  const cached = lookupByRepos.get(repoRows)
  if (cached) {
    return cached
  }

  const byId = new Map<string, IndexedRepo>()
  const byPath = new Map<string, IndexedRepo>()
  const byIdAndPath = new Map<string, IndexedRepo>()
  const byHostAndPath = new Map<string, IndexedRepo>()
  const byHostIdAndPath = new Map<string, IndexedRepo>()
  let indexedCount = 0

  const scanUntil = (
    matches: (repoId: string, repoPath: string, hostId: string) => boolean
  ): Repo | undefined => {
    while (indexedCount < repoRows.length) {
      const index = indexedCount
      const repo = repoRows[index]
      indexedCount += 1
      const repoId = repo.id
      const repoPath = repo.path
      if (!byId.has(repoId)) {
        byId.set(repoId, { index, repo })
      }
      if (!byPath.has(repoPath)) {
        byPath.set(repoPath, { index, repo })
      }
      const idAndPath = idAndPathKey(repoId, repoPath)
      if (!byIdAndPath.has(idAndPath)) {
        byIdAndPath.set(idAndPath, { index, repo })
      }
      const hostId = getRepoExecutionHostId(repo)
      const hostAndPath = idAndPathKey(hostId, repoPath)
      if (!byHostAndPath.has(hostAndPath)) {
        byHostAndPath.set(hostAndPath, { index, repo })
      }
      const hostIdAndPath = idAndPathKey(hostId, idAndPath)
      if (!byHostIdAndPath.has(hostIdAndPath)) {
        byHostIdAndPath.set(hostIdAndPath, { index, repo })
      }
      if (matches(repoId, repoPath, hostId)) {
        return repo
      }
    }
    return undefined
  }

  const lookup: GitHubRepoLookupIndex = {
    findById: (repoId) => byId.get(repoId)?.repo ?? scanUntil((id) => id === repoId),
    findByPath: (repoPath) =>
      byPath.get(repoPath)?.repo ?? scanUntil((_id, path) => path === repoPath),
    findByIdOrPath: (repoId, repoPath) => {
      if (!repoId) {
        return lookup.findByPath(repoPath)
      }
      // Why: a twin (one id on two hosts) has a row per host; the request path names which one.
      const exactMatch =
        byIdAndPath.get(idAndPathKey(repoId, repoPath))?.repo ??
        scanUntil((id, path) => id === repoId && path === repoPath)
      if (exactMatch) {
        return exactMatch
      }
      const idMatch = byId.get(repoId)
      const pathMatch = byPath.get(repoPath)
      if (idMatch || pathMatch) {
        if (!pathMatch || (idMatch && idMatch.index < pathMatch.index)) {
          return idMatch?.repo
        }
        return pathMatch.repo
      }
      return scanUntil((id, path) => id === repoId || path === repoPath)
    },
    findOnHost: (hostId, repoId, repoPath) => {
      const exactMatch = repoId
        ? (byHostIdAndPath.get(idAndPathKey(hostId, idAndPathKey(repoId, repoPath)))?.repo ??
          scanUntil((id, path, host) => id === repoId && path === repoPath && host === hostId))
        : undefined
      return (
        exactMatch ??
        byHostAndPath.get(idAndPathKey(hostId, repoPath))?.repo ??
        scanUntil((_id, path, host) => path === repoPath && host === hostId)
      )
    }
  }
  lookupByRepos.set(repoRows, lookup)
  return lookup
}
