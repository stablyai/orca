/** Translate Windows access only for the resource owner’s WSL host, using its registered distro. Pure desktop-side path work; SSH/paired/local hosts have no translation. */
import { parseRoutableExecutionHostId } from './execution-host'
import { parseWslUncPath, toWindowsWslUncPath } from './wsl-paths'

export type WindowsPathAccess = {
  /** The distro as registered, which is the casing every emitted path uses. */
  readonly wslDistro: string
  /** The Windows spelling of an absolute Linux path on the host, or null when it has none. */
  toWindows(linuxPath: string): string | null
  /** The host's Linux path for a `\\wsl.localhost` / `\\wsl$` path into its distro, else null. */
  fromWindows(windowsPath: string): string | null
}

export type WindowsPathAccessContext = {
  platform: NodeJS.Platform | null
  /** The distro behind a WSL host's runtime environment; null for every other environment. */
  wslDistroForEnvironment: (environmentId: string) => string | null | undefined
}

/** Use resource ownership, never focused-host state, for Windows path guards. */
export function windowsPathAccess(
  ownerHostId: string | null | undefined,
  context: WindowsPathAccessContext
): WindowsPathAccess | null {
  if (context.platform !== 'win32') {
    return null
  }
  const host = parseRoutableExecutionHostId(ownerHostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  const distro = context.wslDistroForEnvironment(host.environmentId)?.trim()
  return distro ? wslDistroWindowsPathAccess(distro) : null
}

export function wslDistroWindowsPathAccess(distro: string): WindowsPathAccess {
  return {
    wslDistro: distro,
    toWindows: (linuxPath) => {
      const normalized = normalizeLinuxPath(linuxPath)
      return normalized === null ? null : toWindowsWslUncPath(normalized, distro)
    },
    fromWindows: (windowsPath) => {
      const parsed = parseWslUncPath(stripWin32LongPathPrefix(windowsPath.trim()))
      // Why case-insensitive: Windows folds the distro in UNC paths (`\\wsl.localhost\ubuntu`).
      if (!parsed || !sameWslDistroName(parsed.distro, distro)) {
        return null
      }
      return normalizeLinuxPath(parsed.linuxPath)
    }
  }
}

export function sameWslDistroName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

export type WindowsPathRejection =
  | { kind: 'windows-drive' }
  | { kind: 'other-distro'; distro: string }
  | { kind: 'not-wsl' }

/** Why `fromWindows` refused a path, for copy that tells the user what to pick instead. */
export function classifyRejectedWindowsPath(windowsPath: string): WindowsPathRejection {
  const trimmed = stripWin32LongPathPrefix(windowsPath.trim())
  if (/^[A-Za-z]:([\\/]|$)/.test(trimmed)) {
    return { kind: 'windows-drive' }
  }
  const parsed = parseWslUncPath(trimmed)
  return parsed ? { kind: 'other-distro', distro: parsed.distro } : { kind: 'not-wsl' }
}

export function stripWin32LongPathPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  }
  return /^\\\\\?\\[A-Za-z]:/.test(path) ? path.slice('\\\\?\\'.length) : path
}

/** Absolute, no `..`/backslash/NUL (Windows would read those differently); trailing slash dropped. */
function normalizeLinuxPath(linuxPath: string): string | null {
  if (!linuxPath.startsWith('/') || linuxPath.startsWith('//') || /[\\\0]/.test(linuxPath)) {
    return null
  }
  const segments = linuxPath.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) {
    return null
  }
  return `/${segments.join('/')}`
}
