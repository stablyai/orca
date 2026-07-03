import { isPathInsideOrEqual, resolveRuntimePath } from './cross-platform-path'
import { parseWorkspaceKey } from './workspace-scope'
import { splitWorktreeIdForFilesystem } from './worktree-id'

export function resolveTerminalStartupCwd(
  worktreePath: string,
  requestedCwd?: string | null
): string | undefined {
  if (!requestedCwd || requestedCwd.trim().length === 0) {
    return undefined
  }
  const resolvedCwd = resolveRuntimePath(worktreePath, requestedCwd)
  if (!isPathInsideOrEqual(worktreePath, resolvedCwd)) {
    // Why: remote/session clients can request terminal cwd; never let that
    // become a shell outside the selected workspace.
    throw new Error('Terminal cwd must be inside the selected worktree.')
  }
  return resolvedCwd
}

export function resolveTerminalStartupCwdForWorkspace(args: {
  workspaceId?: string
  requestedCwd?: string | null
  resolveFolderWorkspacePath?: (folderWorkspaceId: string) => string | null | undefined
}): string | undefined {
  if (!args.requestedCwd || args.requestedCwd.trim().length === 0) {
    return undefined
  }
  const workspacePath = resolveTerminalWorkspacePath(
    args.workspaceId,
    args.resolveFolderWorkspacePath
  )
  if (!workspacePath) {
    return args.requestedCwd
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
