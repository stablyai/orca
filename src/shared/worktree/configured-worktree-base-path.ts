import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from '../cross-platform-path'
import type { Repo } from '../repo-types'
import { resolveWslRepoWorktreeBasePath } from '../wsl-paths'

export function isRuntimePathAbsoluteForRepo(repoPath: string, layoutPath: string): boolean {
  const trimmedLayoutPath = layoutPath.trim()
  const pathFlavor =
    isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(trimmedLayoutPath)
      ? 'windows'
      : 'posix'
  return isRuntimePathAbsolute(trimmedLayoutPath, pathFlavor)
}

export function resolveWorkspaceLayoutPath(repoPath: string, layoutPath: string): string {
  const trimmedLayoutPath = layoutPath.trim()
  return isRuntimePathAbsoluteForRepo(repoPath, trimmedLayoutPath)
    ? normalizeRuntimePathSeparators(trimmedLayoutPath)
    : resolveRuntimePath(repoPath, trimmedLayoutPath)
}

/**
 * Resolves a workspace layout path using trimmed semantics while also retaining the legacy
 * untrimmed resolution when a historical layout contained leading or trailing whitespace (#39545).
 */
export function resolveHistoricalWorkspaceLayoutPaths(
  repoPath: string,
  layoutPath: string
): string[] {
  const primaryPath = resolveWorkspaceLayoutPath(repoPath, layoutPath)
  if (layoutPath.trim() === layoutPath) {
    return [primaryPath]
  }
  const pathFlavor =
    isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(layoutPath)
      ? 'windows'
      : 'posix'
  const legacyPath = isRuntimePathAbsolute(layoutPath, pathFlavor)
    ? normalizeRuntimePathSeparators(layoutPath)
    : resolveRuntimePath(repoPath, layoutPath)
  return legacyPath === primaryPath ? [primaryPath] : [primaryPath, legacyPath]
}

/** An explicitly configured project base outranks name-based directory heuristics (#1846, #15232). */
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
