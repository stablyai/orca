import { parseWslUncPath } from './wsl-paths'

const WINDOWS_LONG_PATH_GIT_ARGS = ['-c', 'core.longpaths=true'] as const

/**
 * Global `git -c` options that let a Windows checkout exceed MAX_PATH.
 *
 * Why command scope: Git for Windows aborts deep checkouts with "Filename too
 * long" unless core.longpaths is on, and `-c` applies it to this invocation
 * only — never `--global`, `--system`, or `--local`, so no user config is
 * written. Available since Git 1.9, well under the 2.25 baseline.
 *
 * Why keyed off cwd rather than a wslDistro option: a `C:\...` cwd can still be
 * served by host git.exe even when a distro is configured, and Linux git parses
 * and ignores the key, so only a true `\\wsl.localhost\...` path opts out.
 */
export function windowsLongPathGitArgs(
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== 'win32' || parseWslUncPath(cwd)) {
    return []
  }
  return [...WINDOWS_LONG_PATH_GIT_ARGS]
}
