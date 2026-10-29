import { parseWslUncPath } from './wsl-paths'

const WINDOWS_LONG_PATH_GIT_ARGS = ['-c', 'core.longpaths=true'] as const

/** Enable core.longpaths per invocation without changing user config (supported since Git 1.9).
 * Use cwd, not configured distro: Windows paths may still use git.exe; only real WSL UNC paths opt out. */
export function windowsLongPathGitArgs(
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== 'win32' || parseWslUncPath(cwd)) {
    return []
  }
  return [...WINDOWS_LONG_PATH_GIT_ARGS]
}
