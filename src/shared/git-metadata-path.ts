import { posix, win32 } from 'node:path'
import { parseWslUncPath, toWindowsWslDrivePath, toWindowsWslPath } from './wsl-paths'

// Only /x is guest-rooted; //x is already host UNC syntax. Match resolveWslRepoWorktreeBasePath to avoid double shares.
const GUEST_ROOTED_PATH = /^\/(?!\/)/

export type GitMetadataPathOptions = {
  /** Host that reads the pointer back. Defaults to the current process platform. */
  platform?: NodeJS.Platform
  /** Distro that wrote the pointer, for callers whose base path does not encode one. Windows-only. */
  wslDistro?: string
}

/** Resolve gitdir/commondir pointers in the reader’s namespace; WSL /mnt/c would otherwise become nonexistent Win32 C:\mnt\c. Empty pointers return null. */
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
  if (GUEST_ROOTED_PATH.test(value)) {
    const translated = translateGuestPointer(value, basePath, platform, options.wslDistro)
    if (translated) {
      return translated
    }
  }
  const host = platform === 'win32' ? win32 : posix
  return host.isAbsolute(value) ? value : host.resolve(basePath, value)
}

/** A WSL UNC base identifies its namespace/distro and overrides platform or caller hints.
 * Otherwise translate only for Windows readers, using the supplied distro or derivable drvfs paths. */
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

/** Convert WSL-reported worktree directories to the reader’s drive/UNC namespace.
 * Unlike newline-terminated metadata pointers, directory names may start/end with whitespace; preserve it when no translation occurs. */
export function resolveWorktreeHostPath(
  worktreePath: string,
  options: GitMetadataPathOptions = {}
): string | null {
  const resolved = resolveGitMetadataPath('', worktreePath, options)
  return resolved === worktreePath.trim() ? worktreePath : resolved
}
