import type { GitStashFile, GitStashSummary } from '../../../../../../shared/git-stash'

export type StashFilesCache = Record<string, GitStashFile[]>

export function stashFilesCacheKey(stash: GitStashSummary): string {
  return stash.commitId
}

export function retainCurrentStashFiles(
  cache: StashFilesCache,
  stashes: GitStashSummary[]
): StashFilesCache {
  const currentCommitIds = new Set(stashes.map(stashFilesCacheKey))
  return Object.fromEntries(
    Object.entries(cache).filter(([commitId]) => currentCommitIds.has(commitId))
  )
}
