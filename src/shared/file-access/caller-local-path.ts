import { posix, resolve as resolvePath, win32 } from 'node:path'
import { isWslUncPath, toWindowsWslDrivePath, toWindowsWslUncPath } from './wsl-paths'

/** A path a caller on this machine typed, resolved against its cwd as its shell would. */
export function resolveCallerLocalPath(
  inputPath: string,
  cwd: string,
  wslDistro: string | null
): string {
  // A Linux absolute path from a WSL shell names a distro file, even when cwd is a drive path.
  if (wslDistro && inputPath.startsWith('/') && !inputPath.startsWith('//')) {
    const linuxPath = posix.normalize(inputPath)
    // WSL refuses drive mounts over UNC, and a UNC cwd keeps its \\wsl$ or \\wsl.localhost spelling.
    return (
      toWindowsWslDrivePath(linuxPath) ??
      win32.resolve(isWslUncPath(cwd) ? cwd : toWindowsWslUncPath('/', wslDistro), linuxPath)
    )
  }
  return resolvePath(cwd, inputPath)
}
