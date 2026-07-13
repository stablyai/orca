import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../../shared/wsl-paths'

/** Platform an agent launches on for a folder workspace, derived from its
 *  host provenance: an SSH group runs on the remote (Windows or Linux by
 *  path shape), a WSL UNC path runs in the distro, everything else is local. */
export function getFolderWorkspaceAgentLaunchPlatform(source: {
  connectionId?: string | null
  parentPath?: string | null
}): NodeJS.Platform {
  const parentPath = source.parentPath?.trim() ?? ''
  if (source.connectionId) {
    return isWindowsAbsolutePathLike(parentPath) ? 'win32' : 'linux'
  }
  return parentPath && isWslUncPath(parentPath) ? 'linux' : CLIENT_PLATFORM
}
