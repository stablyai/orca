import type { AppState } from '../../../store/types'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { workspaceOwnerHostId } from './workspace-row-owner-host'
import { useAppStoreWithChannels } from '@/store/channels/use-app-store-with-channels'

export function selectWorkspaceRuntimeEnvironmentId(
  state: AppState,
  worktreeId: string | null | undefined
): string | null {
  const host = worktreeId ? parseExecutionHostId(workspaceOwnerHostId(state, worktreeId)) : null
  return host?.kind === 'runtime' ? host.environmentId : null
}

export function useWorkspaceRuntimeEnvironmentId(
  worktreeId: string | null | undefined
): string | null {
  return useAppStoreWithChannels((state) => selectWorkspaceRuntimeEnvironmentId(state, worktreeId))
}
