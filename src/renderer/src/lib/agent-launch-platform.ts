import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { AppState } from '@/store'

export function getAgentLaunchPlatformForRepo(
  repo: Pick<AppState['repos'][number], 'connectionId' | 'path'>
): NodeJS.Platform {
  if (!repo.connectionId) {
    return CLIENT_PLATFORM
  }
  return isWindowsAbsolutePathLike(repo.path) ? 'win32' : 'linux'
}
