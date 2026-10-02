export type BrowsePathParts =
  | { kind: 'posix'; segments: string[] }
  | { kind: 'drive'; driveRoot: string; segments: string[] }
  | { kind: 'unc'; uncRoot: string; segments: string[] }

// Bare `M:` is a root here because forwarding it would be drive-relative.
const DRIVE_ANCHOR_RE = /^[A-Za-z]:([\\/]|$)/

export function isDrivePath(p: string): boolean {
  return DRIVE_ANCHOR_RE.test(p)
}

export function isDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(p)
}

export function driveRootOf(p: string): string {
  return `${p[0].toUpperCase()}:\\`
}

// `\\server\share`, `\\?\UNC\server\share` and `\\?\C:` roots; nothing is browsable above them.
const UNC_ROOT_RE =
  /^(?:[\\/]{2}\?[\\/](?:UNC[\\/][^\\/]+[\\/][^\\/]+|[A-Za-z]:)|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/][^\\/]+)/i

export function uncRootOf(p: string): string | null {
  const match = UNC_ROOT_RE.exec(p)
  return match ? `${match[0].replace(/\//g, '\\')}\\` : null
}

export function splitBrowsePath(
  p: string,
  pathFlavor: FilesystemPathFlavor = 'posix'
): BrowsePathParts {
  const uncRoot = pathFlavor === 'win32' ? uncRootOf(p) : null
  if (uncRoot) {
    return {
      kind: 'unc',
      uncRoot,
      segments: p
        .slice(uncRoot.length - 1)
        .split(/[\\/]/)
        .filter(Boolean)
    }
  }
  if (pathFlavor === 'win32' && isDrivePath(p)) {
    return {
      kind: 'drive',
      driveRoot: driveRootOf(p),
      segments: p.slice(2).split(/[\\/]/).filter(Boolean)
    }
  }
  return { kind: 'posix', segments: p.split('/').filter(Boolean) }
}

// Backslash targets the remote Windows host regardless of the client's platform.
export function joinDrivePath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, '')}\\${name}`
}

// Up from a drive root returns to the host drive list.
export function parentOfDrivePath(p: string): string {
  if (isDriveRoot(p)) {
    return '/'
  }
  const parts = splitBrowsePath(p, 'win32')
  if (parts.kind !== 'drive') {
    return p
  }
  const parentSegments = parts.segments.slice(0, -1)
  return parentSegments.length === 0
    ? parts.driveRoot
    : `${parts.driveRoot}${parentSegments.join('\\')}`
}

// UNC share roots have no browsable parent, so up stays put.
export function parentOfUncPath(p: string): string {
  const parts = splitBrowsePath(p, 'win32')
  if (parts.kind !== 'unc') {
    return p
  }
  return parts.segments.length === 0
    ? p
    : driveBreadcrumbPath(parts.uncRoot, parts.segments, parts.segments.length - 2)
}

export function driveBreadcrumbPath(
  driveRoot: string,
  segments: string[],
  endIndex: number
): string {
  const kept = segments.slice(0, endIndex + 1)
  return kept.length === 0 ? driveRoot : `${driveRoot}${kept.join('\\')}`
}
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'
