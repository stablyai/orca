import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import {
  isWslUncPathForCallerLinuxPath,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from './cross-platform-path'
import { parseWorkspaceKey } from './workspace-scope'
import { parseWslUncPath } from './wsl-paths'
import { splitWorktreeIdForFilesystem } from './worktree/id'

export type TerminalStartupCwdMissingDirFallback = {
  // Inject existence checks: only the execution host can probe SSH/remote paths.
  directoryExists: (path: string) => boolean
  onFallbackToWorkspaceRoot?: (missingCwd: string) => void
}

export function resolveTerminalStartupCwd(
  worktreePath: string,
  requestedCwd?: string | null,
  missingDirFallback?: TerminalStartupCwdMissingDirFallback
): string | undefined {
  const trimmedCwd = requestedCwd?.trim()
  if (!trimmedCwd) {
    return undefined
  }
  // Anchor relative requests at the workspace root, but allow cwd outside it (for example after cd .., #7685).
  const resolvedCwd = resolveRuntimePath(worktreePath, trimmedCwd)
  if (
    missingDirFallback &&
    resolvedCwd !== worktreePath &&
    !missingDirFallback.directoryExists(resolvedCwd) &&
    missingDirFallback.directoryExists(worktreePath)
  ) {
    // Deleted startup folders otherwise fail every retry (#7239). Fall back only to an existing root; a missing root must retain the provider’s real error.
    missingDirFallback.onFallbackToWorkspaceRoot?.(resolvedCwd)
    return worktreePath
  }
  return resolvedCwd
}

export function resolveTerminalStartupCwdForWorkspace(args: {
  workspaceId?: string
  requestedCwd?: string | null
  resolveFolderWorkspacePath?: (folderWorkspaceId: string) => string | null | undefined
  missingDirFallback?: TerminalStartupCwdMissingDirFallback
}): string | undefined {
  if (!args.requestedCwd || args.requestedCwd.trim().length === 0) {
    return undefined
  }
  if (args.workspaceId === FLOATING_TERMINAL_WORKTREE_ID) {
    // Floating cwds were resolved against trusted-directory grants and have no workspace root.
    return args.requestedCwd
  }
  const workspacePath = resolveTerminalWorkspacePath(
    args.workspaceId,
    args.resolveFolderWorkspacePath
  )
  if (!workspacePath) {
    // Without a workspace root, use the provider default instead of guessing a relative base.
    return undefined
  }
  return resolveTerminalStartupCwd(workspacePath, args.requestedCwd, args.missingDirFallback)
}

/** Root folder of a worktree, repo checkout or folder workspace id; null for floating terminals. */
export function resolveTerminalWorkspacePath(
  workspaceId: string | undefined,
  resolveFolderWorkspacePath: ((folderWorkspaceId: string) => string | null | undefined) | undefined
): string | null {
  if (!workspaceId) {
    return null
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return resolveFolderWorkspacePath?.(scope.folderWorkspaceId) ?? null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  return splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null
}

/** Structured sessions run at the workspace root; only a distinct cwd requires a terminal.
 * Accept equivalent spellings (including Windows case/separators and WSL UNC/Linux aliases); an unknown root cannot prove equivalence, so stays custom. */
export function requestsCwdOutsideWorkspaceRoot(
  workspacePath: string | null | undefined,
  requestedCwd: string | null | undefined
): boolean {
  const trimmedCwd = requestedCwd?.trim()
  if (!trimmedCwd) {
    return false
  }
  if (!workspacePath) {
    return true
  }
  const resolved = resolveTerminalStartupCwd(workspacePath, trimmedCwd) ?? trimmedCwd
  if (
    normalizeRuntimePathForComparison(resolved) === normalizeRuntimePathForComparison(workspacePath)
  ) {
    return false
  }
  // Why: an agent inside a WSL workspace records its cwd as a Linux path, which the workspace's
  // own distro reads as the root.
  const wslRoot = parseWslUncPath(workspacePath)
  return !(wslRoot && isWslUncPathForCallerLinuxPath(workspacePath, trimmedCwd, wslRoot.distro))
}

/** Use the caller’s known root before deriving it as terminal creation does; floating workspaces have no root, so every cwd is custom. */
export function requestsCwdOutsideWorkspaceRootForWorkspace(args: {
  workspaceId?: string
  requestedCwd?: string | null
  /** The root as the caller already knows it; consulted before the id is parsed for one. */
  workspacePath?: string | null
  resolveFolderWorkspacePath?: (folderWorkspaceId: string) => string | null | undefined
}): boolean {
  if (!args.requestedCwd?.trim()) {
    return false
  }
  if (args.workspaceId === FLOATING_TERMINAL_WORKTREE_ID) {
    return true
  }
  const workspacePath =
    args.workspacePath ??
    resolveTerminalWorkspacePath(args.workspaceId, args.resolveFolderWorkspacePath)
  return requestsCwdOutsideWorkspaceRoot(workspacePath, args.requestedCwd)
}
