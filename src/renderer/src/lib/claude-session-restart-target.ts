import type { AppState } from '@/store'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import {
  getLocalProjectExecutionRuntimeContext,
  getWslDistroFromPath
} from '@/lib/local-preflight-context'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../../shared/worktree-id'

export type ClaudeSessionRestartTarget = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

type RestartCandidateTab = AppState['tabsByWorktree'][string][number]

type LocalRuntimeScope =
  | { runtime: 'host' }
  | { runtime: 'wsl'; wslDistro: string | null }
  | { runtime: 'remote' }

function normalizeDistro(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function isRemoteExecutionHost(hostId: string | null | undefined): boolean {
  const parsed = parseExecutionHostId(hostId ?? LOCAL_EXECUTION_HOST_ID)
  return parsed?.kind === 'ssh' || parsed?.kind === 'runtime'
}

function getProjectRuntimeScope(
  resolution: ProjectExecutionRuntimeResolution | undefined
): LocalRuntimeScope | null {
  if (!resolution) {
    return null
  }
  switch (resolution.status) {
    case 'repair-required':
      return {
        runtime: 'wsl',
        wslDistro: normalizeDistro(resolution.repair.preferredRuntime.distro)
      }
    case 'resolved':
      switch (resolution.runtime.kind) {
        case 'wsl':
          return { runtime: 'wsl', wslDistro: resolution.runtime.distro }
        case 'windows-host':
        case 'local-host':
          return { runtime: 'host' }
      }
  }
}

function getFolderWorkspaceRuntimeScope(
  state: AppState,
  folderWorkspaceId: string
): LocalRuntimeScope {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return { runtime: 'host' }
  }
  const projectGroup = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  if (isRemoteExecutionHost(projectGroup?.executionHostId)) {
    return { runtime: 'remote' }
  }

  const connectionId = getFolderWorkspaceConnectionId(state, folderWorkspaceId)
  if (connectionId) {
    return { runtime: 'remote' }
  }

  const wslDistro = getWslDistroFromPath(workspace.folderPath)
  return wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
}

function findWorktree(state: AppState, worktreeId: string) {
  return (
    Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId) ?? null
  )
}

function getWorktreeRuntimeScope(state: AppState, worktreeId: string): LocalRuntimeScope {
  const worktree = findWorktree(state, worktreeId)
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos.find((entry) => entry.id === repoId) ?? null
  if (
    isRemoteExecutionHost(worktree?.hostId) ||
    (repo && isRemoteExecutionHost(getRepoExecutionHostId(repo)))
  ) {
    return { runtime: 'remote' }
  }

  const projectRuntime = getLocalProjectExecutionRuntimeContext(
    state,
    worktreeId,
    getRendererAppPlatform()
  )
  const projectRuntimeScope = getProjectRuntimeScope(projectRuntime)
  if (projectRuntimeScope) {
    return projectRuntimeScope
  }

  const path = worktree?.path ?? splitWorktreeId(worktreeId)?.worktreePath ?? repo?.path
  const wslDistro = getWslDistroFromPath(path)
  return wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
}

function getTabRuntimeScope(state: AppState, tab: RestartCandidateTab): LocalRuntimeScope {
  const workspaceScope = parseWorkspaceKey(tab.worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getFolderWorkspaceRuntimeScope(state, workspaceScope.folderWorkspaceId)
  }
  return getWorktreeRuntimeScope(state, tab.worktreeId)
}

function runtimeScopeMatchesTarget(
  scope: LocalRuntimeScope,
  target: ClaudeSessionRestartTarget
): boolean {
  if (scope.runtime === 'remote') {
    return false
  }
  if (target.runtime === 'host') {
    return scope.runtime === 'host'
  }
  const targetDistro = normalizeDistro(target.wslDistro)
  return scope.runtime === 'wsl' && (!targetDistro || scope.wslDistro === targetDistro)
}

function isLocalPtyId(ptyId: string): boolean {
  return parseRemoteRuntimePtyId(ptyId) === null && parseAppSshPtyId(ptyId) === null
}

export function getTargetScopedClaudeRestartPtyIds(
  state: AppState,
  tab: RestartCandidateTab,
  ptyIds: string[],
  target: ClaudeSessionRestartTarget | null | undefined
): string[] {
  if (!target) {
    return ptyIds
  }
  if (!runtimeScopeMatchesTarget(getTabRuntimeScope(state, tab), target)) {
    return []
  }
  // Why: local Claude account switches do not rewrite credentials inside SSH or
  // runtime-owned terminals, even if stale tab metadata still looks local.
  return ptyIds.filter(isLocalPtyId)
}
