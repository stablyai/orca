import type { useAppStore } from '@/store'
import { isConnectingSshStatus } from '../ssh/ssh-connection-recoverability'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import { resolveDirectSshTargetScope } from './direct-ssh-target-scope'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export function getSleepingAgentRemoteHydrationTargetId(
  state: AppStoreState,
  worktreeId: string
): string | null {
  const host = parseExecutionHostId(getResolvedExecutionHostIdForWorktree(state, worktreeId))
  if (host?.kind !== 'ssh') {
    return null
  }
  const scope = resolveDirectSshTargetScope({
    targetId: host.targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  })
  // Why: folder workspaces are not part of the remote tab snapshot projection.
  if (!scope.gitWorktreeIds.has(worktreeId)) {
    return null
  }
  if (state.remoteWorkspaceHydratedTargetIds.has(host.targetId)) {
    return null
  }
  const status = state.sshConnectionStates.get(host.targetId)?.status
  if (status !== 'connected' && !isConnectingSshStatus(status)) {
    return null
  }
  const phase = state.remoteWorkspaceSyncStatusByTargetId[host.targetId]?.phase
  return phase === undefined || phase === 'pulling' ? host.targetId : null
}

// Why: direct-SSH tabs are not authoritative until their snapshot-owned pull settles.
export function shouldDeferSleepingAgentResumeForRemoteHydration(
  state: AppStoreState,
  worktreeId: string
): boolean {
  return getSleepingAgentRemoteHydrationTargetId(state, worktreeId) !== null
}
