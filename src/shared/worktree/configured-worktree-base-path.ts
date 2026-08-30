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

/** Resolves one configured base path against the repo: a POSIX-absolute value on a
 *  WSL repo lands inside the distro, and a relative one resolves from the repo root. */
export function resolveConfiguredWorktreeBasePath(repoPath: string, configured: string): string {
  return resolveWorkspaceLayoutPath(repoPath, resolveWslRepoWorktreeBasePath(repoPath, configured))
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
  return [resolveConfiguredWorktreeBasePath(repo.path, configured)]
}
