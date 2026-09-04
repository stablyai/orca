import type { AppState } from '../types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../../shared/local-windows-terminal-runtime'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getIndexedRepoMap, getIndexedWorktreeMap } from '../worktree-repo-index'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

export function isWindowsRendererRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
}

export function isAllowedRemoteWindowsTerminalShell(shell: string | undefined): boolean {
  return (
    shell === 'powershell.exe' ||
    shell === 'pwsh.exe' ||
    shell === 'cmd.exe' ||
    shell === 'wsl.exe' ||
    shell === WINDOWS_GIT_BASH_SHELL
  )
}

export function resolveCreatedTabShellOverride(
  explicitShellOverride: string | undefined,
  defaultWindowsShell: string | undefined,
  isRemoteWorktree: boolean,
  remotePlatform: NodeJS.Platform | null,
  isWslWorktree: boolean,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): string | undefined {
  if (isRemoteWorktree) {
    if (remotePlatform === 'win32' && isAllowedRemoteWindowsTerminalShell(explicitShellOverride)) {
      return explicitShellOverride
    }
    return undefined
  }
  if (isWindowsRendererRuntime()) {
    return resolveLocalWindowsTerminalShellOverrideForTab({
      explicitShellOverride,
      defaultWindowsShell,
      isWslWorktree,
      projectRuntime
    })
  }
  if (explicitShellOverride !== undefined) {
    return explicitShellOverride
  }
  return undefined
}

export function worktreeUsesWslPath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string
): boolean {
  const parsed = parseWorkspaceKey(worktreeId)
  if (parsed?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (workspace) => workspace.id === parsed.folderWorkspaceId
    )
    return folderWorkspace ? isWslUncPath(folderWorkspace.folderPath) : false
  }
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
  return worktree ? isWslUncPath(worktree.path) : false
}

export function worktreeUsesRemoteConnection(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string
): boolean {
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return Boolean(getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId))
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const directRepo = repoMap.get(getRepoIdFromWorktreeId(worktreeId))
  if (directRepo) {
    return Boolean(directRepo.connectionId)
  }
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
  const repo = worktree ? repoMap.get(worktree.repoId) : null
  return Boolean(repo?.connectionId)
}

export function getRemoteConnectionIdForWorktree(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string,
  /**
   * The host the caller picked from a surface listing one row per host. Only a REMOTE
   * pick is taken as given: `local` in a workspace catalog means "nothing named a host",
   * which is exactly what the repo lookup below answers.
   */
  pickedExecutionHostId?: ExecutionHostId
): string | null {
  const picked = parseExecutionHostId(pickedExecutionHostId)
  if (picked?.kind === 'ssh') {
    return picked.targetId
  }
  if (picked?.kind === 'runtime') {
    return null
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId) ?? null
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const directRepo = repoMap.get(getRepoIdFromWorktreeId(worktreeId))
  if (directRepo) {
    return directRepo.connectionId?.trim() || null
  }
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
  const repo = worktree ? repoMap.get(worktree.repoId) : null
  return repo?.connectionId?.trim() || null
}

export function resolveTerminalStopRuntimeEnvironmentId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId)
}
