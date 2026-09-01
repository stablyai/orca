import { posix, win32 } from 'node:path'
import { parseWslUncPath, toWindowsWslDrivePath, toWindowsWslPath } from './wsl-paths'

/**
 * Resolve a Git metadata pointer (a `.git` gitfile payload or a `commondir`) in the path namespace
 * of the host that reads it.
 *
 * Why: git running inside WSL writes these pointers in the guest namespace, but Node reads them
 * back through Win32, where a drvfs pointer like `/mnt/c/repo/.git` silently means
 * `C:\mnt\c\repo\.git`. Returns null only for an empty pointer.
 */
export function resolveGitMetadataPath(
  basePath: string,
  rawPath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const value = rawPath.trim()
  if (!value) {
    return null
  }
  if (value.startsWith('/')) {
    const translated = translateGuestPointer(value, basePath, platform)
    if (translated) {
      return translated
    }
  }
  const host = platform === 'win32' ? win32 : posix
  return host.isAbsolute(value) ? value : host.resolve(basePath, value)
}

/**
 * The Win32 spelling of a POSIX-rooted pointer, or null to leave it alone. A WSL UNC base names the
 * distro that wrote the pointer; failing that, only a drvfs mount has a spelling we can derive, and
 * only a Windows host needs one.
 */
function translateGuestPointer(
  value: string,
  basePath: string,
  platform: NodeJS.Platform
): string | null {
  const distro = parseWslUncPath(basePath)?.distro
  if (distro) {
    return toWindowsWslPath(value, distro)
  }
  return platform === 'win32' ? toWindowsWslDrivePath(value) : null
}
