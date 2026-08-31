import type { AppState } from '../types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../../shared/local-windows-terminal-runtime'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  normalizeWorktreeLookupId,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from '@/lib/worktree-runtime-owner-index'

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
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return false
  }
  const resolution = resolveIndexedWorktreeOwner(state.worktreesByRepo, rawWorktreeId)
  return resolution.kind === 'resolved' && typeof resolution.owner.path === 'string'
    ? isWslUncPath(resolution.owner.path)
    : false
}

export function worktreeUsesRemoteConnection(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string
): boolean {
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return Boolean(getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId))
  }
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return false
  }
  const worktree = resolveIndexedWorktreeOwner(state.worktreesByRepo, rawWorktreeId)
  if (worktree.kind === 'ambiguous') {
    return false
  }
  const repoId =
    worktree.kind === 'resolved' ? worktree.owner.repoId : getRepoIdFromWorktreeId(rawWorktreeId)
  const repo = resolveIndexedRepoOwner(state.repos, repoId)
  return repo.kind === 'resolved' && Boolean(repo.owner.connectionId)
}

export function getRemoteConnectionIdForWorktree(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId) ?? null
  }
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return null
  }
  const worktree = resolveIndexedWorktreeOwner(state.worktreesByRepo, rawWorktreeId)
  if (worktree.kind === 'ambiguous') {
    return null
  }
  const repoId =
    worktree.kind === 'resolved' ? worktree.owner.repoId : getRepoIdFromWorktreeId(rawWorktreeId)
  const repo = resolveIndexedRepoOwner(state.repos, repoId)
  return repo.kind === 'resolved' ? repo.owner.connectionId?.trim() || null : null
}

export function resolveTerminalStopRuntimeEnvironmentId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId)
}
