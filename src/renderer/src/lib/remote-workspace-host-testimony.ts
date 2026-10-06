import type { RemoteWorkspaceSyncStatus } from '@/store/slices/ssh'

export type RemoteWorkspaceTestimonyState = {
  remoteWorkspaceHydratedTargetIds?: ReadonlySet<string>
  remoteWorkspaceSyncStatusByTargetId?: Record<string, RemoteWorkspaceSyncStatus>
}

/**
 * The pair `use-app-session-persistence` gates uploads on: a snapshot has landed for this target
 * and it did not conflict, so the client's picture IS the host's.
 */
export function hostHasAnsweredForTarget(
  state: RemoteWorkspaceTestimonyState,
  targetId: string
): boolean {
  return (
    state.remoteWorkspaceHydratedTargetIds?.has(targetId) === true &&
    state.remoteWorkspaceSyncStatusByTargetId?.[targetId]?.phase !== 'conflict'
  )
}
