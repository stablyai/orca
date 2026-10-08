import type { WorkspaceCopyReadiness } from './workspace-copy-types'

/** Windows 11 24H2: the first build whose robocopy block-clones files on a Dev Drive. */
export const MIN_BLOCK_CLONE_BUILD = 26100

/** Microsoft's guide to creating a Dev Drive. */
export const DEV_DRIVE_SETUP_URL = 'https://learn.microsoft.com/windows/dev-drive/'

/** The host's operating system cannot make copies at all, whatever its drives (macOS, Linux, older Windows). */
export function isCopyPlatformUnsupported(
  readiness: Pick<WorkspaceCopyReadiness, 'windowsBuild'>
): boolean {
  return readiness.windowsBuild === null || readiness.windowsBuild < MIN_BLOCK_CLONE_BUILD
}
