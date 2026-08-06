import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { resolveRuntimePath } from './cross-platform-path'
import { parseWorkspaceKey } from './workspace-scope'
import { splitWorktreeIdForFilesystem } from './worktree-id'

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
