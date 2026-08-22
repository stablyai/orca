import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'

const TOPOLOGY_KEYS = [
  'workspaceSessionReady',
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'remoteWorkspaceHydratedTargetIds',
  'sshConnectionStates',
  'remoteWorkspaceSyncStatusByTargetId'
] as const satisfies readonly (keyof AppState)[]

export function didSleepingAgentHydrationTopologyChange(
  state: AppState,
  previousState: AppState
): boolean {
  return TOPOLOGY_KEYS.some((key) => state[key] !== previousState[key])
}

export function subscribeToSleepingAgentHydrationTopology(
  store: Pick<StoreApi<AppState>, 'subscribe'>,
  listener: () => void
): () => void {
  return store.subscribe((state, previousState) => {
    if (didSleepingAgentHydrationTopologyChange(state, previousState)) {
      listener()
    }
  })
}
