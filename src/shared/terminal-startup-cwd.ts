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
  // Why: only local callers can probe the filesystem — SSH/remote worktree
  // paths live on another host — so the existence check is injected.
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
  // Why: resolve relative requests against the worktree root and normalize
  // `..`; the cwd is intentionally not constrained to the worktree, so opening
  // or splitting a terminal outside it (e.g. after `cd ..`) is allowed. (#7685)
  const resolvedCwd = resolveRuntimePath(worktreePath, trimmedCwd)
  if (
    missingDirFallback &&
    resolvedCwd !== worktreePath &&
    !missingDirFallback.directoryExists(resolvedCwd) &&
    missingDirFallback.directoryExists(worktreePath)
  ) {
    // Why: a persisted/inherited startup folder can be deleted later; spawning
    // into it fails on every retry and bricks terminal creation for that tab
    // (#7239), so recover at the workspace root. If the root is missing too
    // (unmounted volume, stopped WSL distro), keep the requested cwd so the
    // provider surfaces its normal error instead of a misleading fallback.
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
    // Why: floating terminals have no worktree root; their cwd was already
    // resolved against the trusted-directory grants in resolveFloatingTerminalCwd.
    return args.requestedCwd
  }
  const workspacePath = resolveTerminalWorkspacePath(
    args.workspaceId,
    args.resolveFolderWorkspacePath
  )
  if (!workspacePath) {
    // Why: without a worktree root we can't anchor a relative request, so fall
    // back to the provider default rather than guessing a base.
    return undefined
  }
  return resolveTerminalStartupCwd(workspacePath, args.requestedCwd, args.missingDirFallback)
}

function resolveTerminalWorkspacePath(
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

/**
 * Whether a requested cwd would start the agent somewhere other than the workspace root.
 *
 * Only such a cwd is a reason to route a launch to a terminal: a structured session runs in its
 * workspace and cannot honour any other directory. A cwd that names the root, however it is
 * spelled — trailing slash, `.`, a relative path back to it, Windows separators or case, either WSL
 * UNC alias or the distro's own Linux path — asks for nothing a structured session cannot give. An
 * unknown root is read as a custom cwd: the launch cannot prove the request names the root, so it
 * keeps the surface that can honour it.
 */
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

/** `requestsCwdOutsideWorkspaceRoot` for a workspace named by id, with the root taken from the
 *  caller's own record of it when one exists, else derived the way terminal creation derives it.
 *  The floating workspace has no root, so any cwd there is custom. */
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
