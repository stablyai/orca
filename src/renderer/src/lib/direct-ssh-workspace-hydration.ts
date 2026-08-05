import type { AppState } from '@/store/types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getConnectionIdFromState } from './connection-owner-resolution'

type DirectSshWorkspaceHydrationState = Pick<
  AppState,
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'worktreesByRepo'
  | 'remoteWorkspaceHydratedTargetIds'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
>

function activeWorkspaceMatchesWorktree(
  state: DirectSshWorkspaceHydrationState,
  worktreeId: string
): boolean {
  if (state.activeWorktreeId === worktreeId) {
    return true
  }
  const scope = state.activeWorkspaceKey ? parseWorkspaceKey(state.activeWorkspaceKey) : null
  return scope?.type === 'worktree' && scope.worktreeId === worktreeId
}

function resolveDirectSshConnectionId(
  state: DirectSshWorkspaceHydrationState,
  worktreeId: string,
  fallbackConnectionId?: string | null
): string | null {
  const resolvedConnectionId = getConnectionIdFromState(state, worktreeId)
  if (resolvedConnectionId !== undefined) {
    return resolvedConnectionId
  }
  const fallback = fallbackConnectionId?.trim()
  if (fallback) {
    return fallback
  }
  if (!activeWorkspaceMatchesWorktree(state, worktreeId)) {
    return null
  }
  const activeHost = parseExecutionHostId(state.activeWorkspaceExecutionHostId)
  return activeHost?.kind === 'ssh' ? activeHost.targetId : null
}

export function directSshWorkspaceOwnsAgentRecovery(
  state: DirectSshWorkspaceHydrationState,
  worktreeId: string,
  fallbackConnectionId?: string | null
): boolean {
  return Boolean(resolveDirectSshConnectionId(state, worktreeId, fallbackConnectionId))
}

export function directSshWorkspaceAwaitsHydration(
  state: DirectSshWorkspaceHydrationState,
  worktreeId: string,
  fallbackConnectionId?: string | null
): boolean {
  const connectionId = resolveDirectSshConnectionId(state, worktreeId, fallbackConnectionId)
  return Boolean(connectionId && !state.remoteWorkspaceHydratedTargetIds.has(connectionId))
}
