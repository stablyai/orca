import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  getWorkspaceRuntimePreference,
  resolveProjectExecutionRuntime
} from '../../../shared/project-execution-runtime'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  getProjectRuntimePreflightContext,
  type LocalPreflightContext
} from './local-preflight-context-cache'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import { findIndexedFolderWorkspaceOwner } from './worktree-runtime-owner-index'

/** A locally owned WSL folder supplies its distro even without a unique repository. */
export function getLocalFolderAgentPreflightContext(
  state: AppState,
  appPlatform: NodeJS.Platform,
  wslContext: Pick<
    Parameters<typeof resolveProjectExecutionRuntime>[0],
    'wslAvailable' | 'availableWslDistros'
  >,
  worktreeId?: string | null
): LocalPreflightContext {
  const targetId = worktreeId ?? state.activeWorktreeId
  const scope = parseWorkspaceKey(targetId ?? '')
  if (
    appPlatform !== 'win32' ||
    !targetId ||
    scope?.type !== 'folder' ||
    getResolvedExecutionHostIdForWorktree(state, targetId) !== LOCAL_EXECUTION_HOST_ID
  ) {
    return undefined
  }
  const folder = findIndexedFolderWorkspaceOwner(
    state.folderWorkspaces,
    scope.folderWorkspaceId,
    LOCAL_EXECUTION_HOST_ID
  )
  if (
    !folder ||
    !parseWslUncPath(folder.folderPath) ||
    resolveFolderWorkspaceHost({ ...state, folderWorkspaces: [folder] }, folder.id).kind !== 'local'
  ) {
    return undefined
  }
  return getProjectRuntimePreflightContext(
    resolveProjectExecutionRuntime({
      appPlatform,
      projectId: targetId,
      projectRuntimePreference: getWorkspaceRuntimePreference(undefined, folder.folderPath),
      globalWindowsRuntimeDefault:
        state.settings?.localWindowsRuntimeDefault ??
        deriveGlobalWindowsRuntimeDefaultFromLegacySettings(state.settings).defaultRuntime,
      ...wslContext
    })
  )
}
