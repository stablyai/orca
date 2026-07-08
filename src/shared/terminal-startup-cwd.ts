import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { resolveRuntimePath } from './cross-platform-path'
import { parseWorkspaceKey } from './workspace-scope'
import { splitWorktreeIdForFilesystem } from './worktree-id'

export function resolveTerminalStartupCwd(
  worktreePath: string,
  requestedCwd?: string | null
): string | undefined {
  const trimmedCwd = requestedCwd?.trim()
  if (!trimmedCwd) {
    return undefined
  }
  // Why: resolve relative requests against the worktree root and normalize
  // `..`; the cwd is intentionally not constrained to the worktree, so opening
  // or splitting a terminal outside it (e.g. after `cd ..`) is allowed. (#7685)
  return resolveRuntimePath(worktreePath, trimmedCwd)
}

export function resolveTerminalStartupCwdForWorkspace(args: {
  workspaceId?: string
  requestedCwd?: string | null
  resolveFolderWorkspacePath?: (folderWorkspaceId: string) => string | null | undefined
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
  return resolveTerminalStartupCwd(workspacePath, args.requestedCwd)
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
