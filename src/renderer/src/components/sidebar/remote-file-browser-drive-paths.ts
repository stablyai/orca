// Windows drive-path support for the remote file browser. Committed picker
// paths are POSIX-shaped (`/`, `/home/user`) on POSIX hosts but drive-shaped
// (`C:\`, `M:\dev`) on Windows hosts; these functions centralize drive
// detection so navigation math never mixes the two shapes.

export type BrowsePathParts =
  | { kind: 'posix'; segments: string[] }
  | { kind: 'drive'; driveRoot: string; segments: string[] }

// Matches a drive anchor at the start of a path or input: `M:`, `M:\`, `M:/`,
// `M:\dev`. A bare `M:` is treated as the drive root — never forwarded as-is,
// because `M:` without a separator is drive-relative on Windows.
const DRIVE_ANCHOR_RE = /^[A-Za-z]:([\\/]|$)/

export function isDrivePath(p: string): boolean {
  return DRIVE_ANCHOR_RE.test(p)
}

export function isDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(p)
}

// Canonical `M:\` root for any drive-anchored input (`m:`, `M:/`, `M:\dev`).
export function driveRootOf(p: string): string {
  return `${p[0].toUpperCase()}:\\`
}

export function splitBrowsePath(p: string): BrowsePathParts {
  if (isDrivePath(p)) {
    return {
      kind: 'drive',
      driveRoot: driveRootOf(p),
      segments: p.slice(2).split(/[\\/]/).filter(Boolean)
    }
  }
  return { kind: 'posix', segments: p.split('/').filter(Boolean) }
}

// Why: the backslash is deliberate, not a platform assumption — these paths
// target a remote Windows host regardless of the client OS, and the sandboxed
// renderer bundle has no Node `path.win32` to delegate to.
export function joinDrivePath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, '')}\\${name}`
}

// Parent of a drive path. At the drive root, "up" leaves the drive and lands
// on the host root (`/`), which Windows servers answer with the drive list.
export function parentOfDrivePath(p: string): string {
  if (isDriveRoot(p)) {
    return '/'
  }
  const parts = splitBrowsePath(p)
  if (parts.kind !== 'drive') {
    return p
  }
  const parentSegments = parts.segments.slice(0, -1)
  return parentSegments.length === 0
    ? parts.driveRoot
    : `${parts.driveRoot}${parentSegments.join('\\')}`
}

// Absolute path for a breadcrumb click: drive root plus segments 0..endIndex.
export function driveBreadcrumbPath(
  driveRoot: string,
  segments: string[],
  endIndex: number
): string {
  const kept = segments.slice(0, endIndex + 1)
  return kept.length === 0 ? driveRoot : `${driveRoot}${kept.join('\\')}`
}
