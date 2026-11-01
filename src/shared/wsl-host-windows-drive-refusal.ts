// A WSL host refuses projects on a Windows drive: drvfs reports false CRLF changes, misses Windows-side edits and searches slowly.
import { stripWin32LongPathPrefix } from './windows-path-access'
import { parseWslUncPath } from './wsl-paths'

export const WSL_HOST_WINDOWS_DRIVE_REFUSAL_KIND = 'wsl_host_windows_drive_path'

export type WslHostWindowsDriveRefusal = {
  kind: typeof WSL_HOST_WINDOWS_DRIVE_REFUSAL_KIND
  /** The same folder as this computer sees it, or null when the mount does not say. */
  windowsPath: string | null
}

export function wslHostWindowsDriveRefusalMessage(windowsPath: string | null): string {
  const where = windowsPath
    ? `This folder is on a Windows drive (${windowsPath}).`
    : 'This folder is on a Windows drive.'
  return `${where} Add it on this computer instead: Git in WSL reports false line-ending changes there, misses edits made from Windows, and searches it slowly.`
}

/** Rides in `data` under the existing `runtime_error` code, so older clients still show the message. */
export class WslHostWindowsDriveRefusalError extends Error {
  readonly data: WslHostWindowsDriveRefusal

  constructor(windowsPath: string | null) {
    super(wslHostWindowsDriveRefusalMessage(windowsPath))
    this.name = 'WslHostWindowsDriveRefusalError'
    this.data = { kind: WSL_HOST_WINDOWS_DRIVE_REFUSAL_KIND, windowsPath }
  }
}

export function readWslHostWindowsDriveRefusal(data: unknown): WslHostWindowsDriveRefusal | null {
  if (typeof data !== 'object' || data === null || !('kind' in data)) {
    return null
  }
  if (data.kind !== WSL_HOST_WINDOWS_DRIVE_REFUSAL_KIND) {
    return null
  }
  const windowsPath =
    'windowsPath' in data && typeof data.windowsPath === 'string' && data.windowsPath
      ? data.windowsPath
      : null
  return { kind: WSL_HOST_WINDOWS_DRIVE_REFUSAL_KIND, windowsPath }
}

/** Resolve `.`/`..` lexically, as the host will; null for a relative path. */
function normalizeLinuxPath(linuxPath: string): string | null {
  const segments: string[] = []
  for (const segment of linuxPath.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return linuxPath.startsWith('/') ? `/${segments.join('/')}` : null
}

/** `/mnt/<letter>/…` as this computer spells it. The host re-checks by mount type, so a custom automount root is caught there. */
function windowsPathOfDrvfsLinuxPath(linuxPath: string): string | null {
  const normalized = normalizeLinuxPath(linuxPath.trim())
  const match = normalized?.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/)
  if (!match) {
    return null
  }
  return `${match[1].toUpperCase()}:\\${(match[2] ?? '').split('/').join('\\')}`
}

function refusal(windowsPath: string | null): WslHostWindowsDriveRefusal {
  return { kind: WSL_HOST_WINDOWS_DRIVE_REFUSAL_KIND, windowsPath }
}

/** A path typed for a WSL host. */
export function wslHostWindowsDriveRefusalForLinuxPath(
  linuxPath: string
): WslHostWindowsDriveRefusal | null {
  const windowsPath = windowsPathOfDrvfsLinuxPath(linuxPath)
  return windowsPath ? refusal(windowsPath) : null
}

/** The drive path behind a `\\wsl.localhost\<any distro>\mnt\<letter>` folder, else null. */
export function windowsPathOfWslDrvfsUncPath(windowsPath: string): string | null {
  const parsed = parseWslUncPath(stripWin32LongPathPrefix(windowsPath.trim()))
  return parsed ? windowsPathOfDrvfsLinuxPath(parsed.linuxPath) : null
}

/** A folder picked or dropped from Windows for a WSL host: a drive folder, or a distro's drvfs mount of one. */
export function wslHostWindowsDriveRefusalForPickedPath(
  windowsPath: string
): WslHostWindowsDriveRefusal | null {
  const stripped = stripWin32LongPathPrefix(windowsPath.trim())
  if (/^[A-Za-z]:([\\/]|$)/.test(stripped)) {
    return refusal(stripped)
  }
  const drivePath = windowsPathOfWslDrvfsUncPath(stripped)
  return drivePath ? refusal(drivePath) : null
}
