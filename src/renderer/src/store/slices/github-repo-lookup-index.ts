import type { Repo } from '../../../../shared/repo-types'

type IndexedRepo = {
  index: number
  repo: Repo
}

export type GitHubRepoLookupIndex = {
  findById: (repoId: string) => Repo | undefined
  findByPath: (repoPath: string) => Repo | undefined
  findByIdOrPath: (repoId: string | undefined, repoPath: string) => Repo | undefined
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
  let indexedCount = 0

  const scanUntil = (matches: (repoId: string, repoPath: string) => boolean): Repo | undefined => {
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
      if (matches(repoId, repoPath)) {
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
      const idMatch = byId.get(repoId)
      const pathMatch = byPath.get(repoPath)
      if (idMatch || pathMatch) {
        if (!pathMatch || (idMatch && idMatch.index < pathMatch.index)) {
          return idMatch?.repo
        }
        return pathMatch.repo
      }
      return scanUntil((id, path) => id === repoId || path === repoPath)
    }
  }
  lookupByRepos.set(repoRows, lookup)
  return lookup
}
