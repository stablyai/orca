import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'
import type { NestedRepoCandidate } from '../../../../../../shared/project-group-types'

export const NESTED_REPO_SCAN_OPTIONS = {
  scanInsideGitRepo: true,
  includeGitignored: true,
  includeHidden: true,
  maxDepth: 4,
  timeoutMs: 15_000
} as const

export function folderPathIsInsideWorktree(worktreePath: string, folderPath: string): boolean {
  return relativePathInsideRoot(worktreePath, folderPath) !== null
}

export function folderPathIsNestedInWorktree(worktreePath: string, folderPath: string): boolean {
  const relative = relativePathInsideRoot(worktreePath, folderPath)
  return relative !== null && relative !== ''
}

export function listNestedRepoParentFolders(
  repoPaths: readonly string[],
  worktreePath: string
): string[] {
  const parents = repoPaths
    .map((repoPath) => repoPath.replace(/[\\/][^\\/]+$/, ''))
    .filter((dir) => folderPathIsNestedInWorktree(worktreePath, dir))
  return [...new Set(parents)].sort()
}

export function displayPathInsideWorktree(worktreePath: string, folderPath: string): string {
  const relative = relativePathInsideRoot(worktreePath, folderPath)
  if (relative === null) {
    return folderPath
  }
  return relative === '' ? '.' : relative
}

export function selectDefaultNestedRepo(
  repos: readonly NestedRepoCandidate[],
  changeCountByPath: ReadonlyMap<string, number>
): string | null {
  if (repos.length === 0) {
    return null
  }
  const dirty = repos.find((repo) => (changeCountByPath.get(repo.path) ?? 0) > 0)
  return (dirty ?? repos[0])?.path ?? null
}
