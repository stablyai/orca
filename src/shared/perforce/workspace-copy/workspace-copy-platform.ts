import type { WorkspaceCopyReadiness } from './workspace-copy-types'

/** Windows 11 24H2: the first build whose robocopy block-clones files on a Dev Drive. */
export const MIN_BLOCK_CLONE_BUILD = 26100

/** Microsoft's guide to creating a Dev Drive. */
export const DEV_DRIVE_SETUP_URL = 'https://learn.microsoft.com/windows/dev-drive/'

/** How a host clones files: robocopy onto a ReFS Dev Drive, or clonefile on APFS. */
export type CopyPlatform = 'windows' | 'macos'

export function copyPlatformOf(platform: NodeJS.Platform): CopyPlatform | null {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : null
}

/** The host's operating system cannot make copies at all, whatever its drives (Linux, older Windows). */
export function isCopyPlatformUnsupported(
  readiness: Pick<WorkspaceCopyReadiness, 'windowsBuild' | 'copyPlatform'>
): boolean {
  if (readiness.copyPlatform === 'macos') {
    return false
  }
  return readiness.windowsBuild === null || readiness.windowsBuild < MIN_BLOCK_CLONE_BUILD
}
