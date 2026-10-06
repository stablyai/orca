import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../shared/wsl-paths'
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
    // Why a WSL path: the pane spawns in the distro's POSIX shell, whatever the Windows shell
    // setting, so its line is judged and quoted for that shell.
    if (
      (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') ||
      isWslUncPath(repo.path)
    ) {
      return 'linux'
    }
    return CLIENT_PLATFORM
  }
  return isWindowsAbsolutePathLike(repo.path) ? 'win32' : 'linux'
}
