import { posix, win32 } from 'node:path'
import { parseWslUncPath, toWindowsWslDrivePath, toWindowsWslPath } from './wsl-paths'

export type GitMetadataPathOptions = {
  /** Host that reads the pointer back. Defaults to the current process platform. */
  platform?: NodeJS.Platform
  /** Distro that wrote the pointer, for callers whose base path does not encode one. Windows-only. */
  wslDistro?: string
}

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
  options: GitMetadataPathOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  const value = rawPath.trim()
  if (!value) {
    return null
  }
  if (value.startsWith('/')) {
    const translated = translateGuestPointer(value, basePath, platform, options.wslDistro)
    if (translated) {
      return translated
    }
  }
  const host = platform === 'win32' ? win32 : posix
  return host.isAbsolute(value) ? value : host.resolve(basePath, value)
}

/**
 * The Win32 spelling of a POSIX-rooted pointer, or null to leave it alone. A WSL UNC base names the
 * distro that wrote the pointer and outranks the caller's guess; failing both, only a drvfs mount
 * has a spelling we can derive.
 *
 * Only a Windows host is translated at all, so a caller-named distro cannot make a POSIX host
 * fabricate a Win32 path. A WSL UNC base is exempt because that spelling only exists on Windows.
 */
function translateGuestPointer(
  value: string,
  basePath: string,
  platform: NodeJS.Platform,
  wslDistro: string | undefined
): string | null {
  const baseDistro = parseWslUncPath(basePath)?.distro
  if (baseDistro) {
    return toWindowsWslPath(value, baseDistro)
  }
  if (platform !== 'win32') {
    return null
  }
  return wslDistro ? toWindowsWslPath(value, wslDistro) : toWindowsWslDrivePath(value)
}
