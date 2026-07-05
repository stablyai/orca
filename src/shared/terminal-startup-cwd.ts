import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { isPathInsideOrEqual, resolveRuntimePath } from './cross-platform-path'
import { parseWorkspaceKey } from './workspace-scope'
import { splitWorktreeIdForFilesystem } from './worktree-id'

export type TerminalStartupCwdOptions = {
  // Why: the string containment check can't see symlinks; only local callers
  // can canonicalize — SSH worktree paths live on the remote host.
  canonicalizePath?: (path: string) => string | null
}

export function resolveTerminalStartupCwd(
  worktreePath: string,
  requestedCwd?: string | null,
  options?: TerminalStartupCwdOptions
): string | undefined {
  const trimmedCwd = requestedCwd?.trim()
  if (!trimmedCwd) {
    return undefined
  }
  const resolvedCwd = resolveRuntimePath(worktreePath, trimmedCwd)
  if (!isPathInsideOrEqual(worktreePath, resolvedCwd)) {
    // Why: remote/session clients can request terminal cwd; never let that
    // become a shell outside the selected workspace.
    throw new Error('Terminal cwd must be inside the selected worktree.')
  }
  const canonicalizePath = options?.canonicalizePath
  if (canonicalizePath) {
    const canonicalWorktreePath = canonicalizePath(worktreePath)
    const canonicalCwd = canonicalizePath(resolvedCwd)
    if (
      canonicalWorktreePath &&
      canonicalCwd &&
      !isPathInsideOrEqual(canonicalWorktreePath, canonicalCwd)
    ) {
      // Why: a symlink escaping the worktree can be legitimate (e.g. a pnpm
      // store link), so fall back to the default cwd instead of failing the
      // spawn — but never grant the requested out-of-worktree shell.
      return undefined
    }
  }
  return resolvedCwd
}

export function resolveTerminalStartupCwdForWorkspace(args: {
  workspaceId?: string
  requestedCwd?: string | null
  resolveFolderWorkspacePath?: (folderWorkspaceId: string) => string | null | undefined
  canonicalizePath?: (path: string) => string | null
}): string | undefined {
  if (!args.requestedCwd || args.requestedCwd.trim().length === 0) {
    return undefined
  }
  if (args.workspaceId === FLOATING_TERMINAL_WORKTREE_ID) {
    // Why: floating terminals have no worktree root to contain within; their
    // cwd was already validated against the trusted-directory grants in
    // resolveFloatingTerminalCwd.
    return args.requestedCwd
  }
  const workspacePath = resolveTerminalWorkspacePath(
    args.workspaceId,
    args.resolveFolderWorkspacePath
  )
  if (!workspacePath) {
    // Why: without a resolvable workspace root we cannot enforce the
    // in-worktree containment check, so refuse the requested cwd rather
    // than trusting an unvalidated path.
    return undefined
  }
  return resolveTerminalStartupCwd(workspacePath, args.requestedCwd, {
    canonicalizePath: args.canonicalizePath
  })
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
