import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { CLIENT_PLATFORM } from './new-workspace'

export function resolveSourceControlLaunchPlatform(args: {
  connectionId?: string | null
  worktreePath?: string | null
}): NodeJS.Platform {
  const path = args.worktreePath?.trim() ?? ''
  if (typeof args.connectionId === 'string') {
    return path && isWindowsAbsolutePathLike(path) && !isWslUncPath(path) ? 'win32' : 'linux'
  }
  if (path && isWslUncPath(path)) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}
