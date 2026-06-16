import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { AppState } from '@/store'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

export function getAgentLaunchPlatformForRepo(
  repo: Pick<AppState['repos'][number], 'connectionId' | 'path'>,
  projectRuntime?: ProjectExecutionRuntimeResolution
): NodeJS.Platform {
  if (!repo.connectionId) {
    if (projectRuntime?.status === 'repair-required') {
      return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
    }
    if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
      return 'linux'
    }
    return CLIENT_PLATFORM
  }
  return isWindowsAbsolutePathLike(repo.path) ? 'win32' : 'linux'
}
