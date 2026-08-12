import type { AppState } from '@/store/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  type ExecutionHostId,
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

type AiVaultOwnerResolutionState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
>

function getWorktreeHostId(worktree: { hostId?: ExecutionHostId }): ExecutionHostId {
  return worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
}

export function getAiVaultResumeRepo(
  state: Pick<AppState, 'repos' | 'worktreesByRepo'>,
  worktreeId: string | null | undefined,
  expectedExecutionHostId?: ExecutionHostId
): { id: string; connectionId?: string | null } | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return null
  }
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  const ownerKeys = new Set<string>()
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      if (worktree.id !== targetWorktreeId) {
        continue
      }
      const repoHostIds = state.repos
        .filter((repo) => repo.id === repoId)
        .map((repo) => getRepoExecutionHostId(repo))
      const executionHostIds = worktree.hostId
        ? [worktree.hostId]
        : repoHostIds.length > 0
          ? repoHostIds
          : [LOCAL_EXECUTION_HOST_ID]
      for (const executionHostId of executionHostIds) {
        if (!expectedExecutionHostId || executionHostId === expectedExecutionHostId) {
          ownerKeys.add(`${repoId}\u0000${executionHostId}`)
        }
      }
    }
  }
  if (ownerKeys.size !== 1) {
    return null
  }
  const [repoId, executionHostId] = [...ownerKeys][0].split('\u0000') as [string, ExecutionHostId]
  const repos = state.repos.filter(
    (candidate) => candidate.id === repoId && getRepoExecutionHostId(candidate) === executionHostId
  )
  return repos.length === 1 ? repos[0] : null
}

export function resolveAiVaultResumeRepoOwner(
  state: AiVaultOwnerResolutionState,
  worktreeId: string | null | undefined,
  expectedExecutionHostId?: ExecutionHostId
): ReturnType<typeof getAiVaultResumeRepo> {
  const workspaceScope = worktreeId ? parseWorkspaceKey(worktreeId) : null
  if (worktreeId && workspaceScope?.type === 'folder') {
    const folder = state.folderWorkspaces.find(
      (candidate) => candidate.id === workspaceScope.folderWorkspaceId
    )
    const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
    if (!folder || (expectedExecutionHostId && executionHostId !== expectedExecutionHostId)) {
      throw new Error('The target workspace host is unavailable or ambiguous.')
    }
    return null
  }
  const repo = getAiVaultResumeRepo(state, worktreeId, expectedExecutionHostId)
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  const hasTargetWorkspaceMetadata = Object.values(state.worktreesByRepo ?? {})
    .flat()
    .some((worktree) => worktree.id === targetWorktreeId)
  if (worktreeId && workspaceScope?.type !== 'folder' && hasTargetWorkspaceMetadata && !repo) {
    throw new Error('The target workspace host is unavailable or ambiguous.')
  }
  return repo
}

export function getAiVaultResumeWorkspacePath(
  state: Pick<AppState, 'folderWorkspaces' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string | null | undefined,
  expectedExecutionHostId?: ExecutionHostId
): string | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  const paths = new Set<string>()
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo ?? {})) {
    const repoHostIds = state.repos
      .filter((repo) => repo.id === repoId)
      .map((repo) => getRepoExecutionHostId(repo))
    for (const worktree of worktrees) {
      const hostIds = worktree.hostId
        ? [worktree.hostId]
        : repoHostIds.length > 0
          ? repoHostIds
          : [getWorktreeHostId(worktree)]
      if (
        worktree.id === targetWorktreeId &&
        (!expectedExecutionHostId || hostIds.includes(expectedExecutionHostId))
      ) {
        paths.add(worktree.path)
      }
    }
  }
  return paths.size === 1 ? [...paths][0] : null
}
