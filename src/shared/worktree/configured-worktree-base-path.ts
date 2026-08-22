import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from '../cross-platform-path'
import type { Repo } from '../repo-types'
import { resolveWslRepoWorktreeBasePath } from '../wsl-paths'

export function isRuntimePathAbsoluteForRepo(repoPath: string, layoutPath: string): boolean {
  const pathFlavor =
    isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(layoutPath)
      ? 'windows'
      : 'posix'
  return isRuntimePathAbsolute(layoutPath, pathFlavor)
}

export function resolveWorkspaceLayoutPath(repoPath: string, layoutPath: string): string {
  return isRuntimePathAbsoluteForRepo(repoPath, layoutPath)
    ? normalizeRuntimePathSeparators(layoutPath)
    : resolveRuntimePath(repoPath, layoutPath)
}

/**
 * Why: the per-project worktree base (#1846) is an explicit statement that a
 * directory holds this project's workspaces, so it outranks the path
 * heuristics that classify directories on their name alone (#15232).
 */
export function resolveConfiguredWorktreeBasePaths(
  repo: Pick<Repo, 'path' | 'worktreeBasePath'> | undefined
): string[] {
  const configured = repo?.worktreeBasePath?.trim()
  if (!repo || !configured) {
    return []
  }
  const runtimeBase = resolveWslRepoWorktreeBasePath(repo.path, configured)
  return [resolveWorkspaceLayoutPath(repo.path, runtimeBase)]
}
