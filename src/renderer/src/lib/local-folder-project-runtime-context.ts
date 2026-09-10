import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  resolveProjectExecutionRuntime,
  type ProjectExecutionRuntimeResolution
} from '../../../shared/project-execution-runtime'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'

type LocalFolderRuntimeState = Pick<AppState, 'activeWorktreeId' | 'repos' | 'settings' | 'worktreesByRepo'> & Partial<Pick<AppState, 'activeWorkspaceExecutionHostId' | 'folderWorkspaces' | 'projectGroups' | 'restoredRuntimeHostIdByWorkspaceSessionKey'>>

type WslContext = {
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}

export function getLocalFolderProjectRuntimeContext(
  state: LocalFolderRuntimeState,
  folderWorkspaceId: string,
  appPlatform: NodeJS.Platform,
  wslContext: WslContext
): ProjectExecutionRuntimeResolution | undefined {
  const folder = state.folderWorkspaces?.find((workspace) => workspace.id === folderWorkspaceId)
  if (
    !folder ||
    getResolvedExecutionHostIdForWorktree(state, folderWorkspaceKey(folderWorkspaceId)) !==
      LOCAL_EXECUTION_HOST_ID
  ) {
    return undefined
  }
  const folderWslDistro = parseWslUncPath(folder.folderPath)?.distro ?? null
  return resolveProjectExecutionRuntime({
    appPlatform,
    projectId: folderWorkspaceId,
    projectRuntimePreference: folderWslDistro
      ? { kind: 'wsl', distro: folderWslDistro }
      : { kind: 'inherit-global' },
    globalWindowsRuntimeDefault:
      state.settings?.localWindowsRuntimeDefault ??
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings(state.settings).defaultRuntime,
    wslAvailable: wslContext.wslAvailable,
    availableWslDistros: wslContext.availableWslDistros
  })
}
