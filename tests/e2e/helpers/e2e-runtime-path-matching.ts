import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../src/shared/cross-platform-path'

type RepoPathSnapshot = {
  id: string
  path: string
}

type WorktreePathSnapshot = {
  id: string
  path: string
}

export function findRepoSnapshotByRuntimePath(
  repos: readonly RepoPathSnapshot[],
  repoPath: string
): RepoPathSnapshot | undefined {
  const expectedPath = normalizeRuntimePathForComparison(repoPath)
  return repos.find((repo) => normalizeRuntimePathForComparison(repo.path) === expectedPath)
}

export function findPrimaryWorktreeSnapshot(
  worktrees: readonly WorktreePathSnapshot[],
  repoPath: string
): WorktreePathSnapshot | undefined {
  return worktrees.find(
    (worktree) =>
      normalizeRuntimePathForComparison(worktree.path) ===
        normalizeRuntimePathForComparison(repoPath) || isPathInsideOrEqual(repoPath, worktree.path)
  )
}

export function formatRepoPathSnapshots(repos: readonly RepoPathSnapshot[]): string {
  if (repos.length === 0) {
    return 'none'
  }
  return repos.map((repo) => `${repo.id}:${repo.path}`).join(', ')
}
