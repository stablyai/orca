/**
 * Paths on a drive letter mapped to a distro share (`net use W: \\wsl.localhost\Ubuntu`), as the
 * WSL move reads them: the same folder as the share's UNC spelling. The mapping is the one read
 * when the move was previewed and journaled, never a fresh read, so recovery maps what it moved.
 */
import { z } from 'zod'
import { normalizeRuntimePathForComparison } from '../file-access/cross-platform-path'
import { parseWslUncPath, wslUncPathToLinux } from '../file-access/wsl-paths'

/** A drive letter mapped to a distro share; `share` may be a folder inside the distro. */
export type WslMappedDrive = { letter: string; share: string }

export const WslMappedDrivesSchema = z
  .array(
    z.object({
      letter: z.string().regex(/^[A-Z]$/),
      share: z
        .string()
        .min(1)
        .max(4_096)
        .refine((share) => parseWslUncPath(share) !== null)
    })
  )
  .max(26)

const DRIVE_ABSOLUTE = /^([A-Za-z]):[\\/]([\s\S]*)$/
const DRIVE_FILE_URL = /^file:\/\/\/([A-Za-z]):(\/[^?#]*)?([?#][\s\S]*)?$/i

/** `W:\home\x` -> `\\wsl.localhost\Ubuntu\home\x`; the tail keeps its case, which Linux needs. */
export function wslMappedDrivePathToShare(value: string, drive: WslMappedDrive): string | null {
  const match = DRIVE_ABSOLUTE.exec(value)
  if (!match || match[1].toUpperCase() !== drive.letter.toUpperCase()) {
    return null
  }
  const segments: string[] = []
  for (const segment of match[2].split(/[\\/]+/)) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      // Past the drive root names no folder of the share.
      if (segments.pop() === undefined) {
        return null
      }
      continue
    }
    segments.push(segment)
  }
  const share = drive.share.replace(/[\\/]+$/, '')
  return segments.length > 0 ? `${share}\\${segments.join('\\')}` : share
}

/** The drive `path` sits on among `mappedDrives`; null for any other path. */
export function wslMappedDriveOf(
  path: string,
  mappedDrives: readonly WslMappedDrive[]
): WslMappedDrive | null {
  const letter = DRIVE_ABSOLUTE.exec(path)?.[1].toUpperCase()
  return (letter && mappedDrives.find((drive) => drive.letter.toUpperCase() === letter)) || null
}

/** The share spelling of a path on one of `mappedDrives`; any other path unchanged. */
export function toWslDistroUncPath(path: string, mappedDrives: readonly WslMappedDrive[]): string {
  const drive = mappedDrives.length > 0 ? wslMappedDriveOf(path, mappedDrives) : null
  return (drive && wslMappedDrivePathToShare(path, drive)) ?? path
}

/** A UNC or mapped-drive path's Linux path in `distro`; null outside it. */
export function wslMoveSourcePathToLinux(
  path: string,
  distro: string,
  mappedDrives: readonly WslMappedDrive[] = []
): string | null {
  return wslUncPathToLinux(toWslDistroUncPath(path, mappedDrives), distro)
}

/** `file:///W:/x` -> `file:///<linux>/x`, keeping the URL's own encoding of the tail. */
export function wslMappedDriveFileUrlToLinux(
  url: string,
  distro: string,
  mappedDrives: readonly WslMappedDrive[]
): string | null {
  const match = mappedDrives.length > 0 ? DRIVE_FILE_URL.exec(url) : null
  const drive = match ? wslMappedDriveOf(`${match[1]}:\\`, mappedDrives) : null
  const root = drive ? wslUncPathToLinux(drive.share, distro) : null
  if (!match || !drive || root === null || !staysOnShare(match[2] ?? '/', drive)) {
    return null
  }
  const encodedRoot = root === '/' ? '' : root.split('/').map(encodeURIComponent).join('/')
  return `file://${encodedRoot}${match[2] ?? '/'}${match[3] ?? ''}`
}

/** A URL tail that, decoded, stays inside the share, as the path form requires. */
function staysOnShare(tail: string, drive: WslMappedDrive): boolean {
  try {
    return wslMappedDrivePathToShare(`${drive.letter}:${decodeURIComponent(tail)}`, drive) !== null
  } catch {
    return false
  }
}

/**
 * A `normalizeRuntimePathForComparison` key on a mapped drive (`w:/home/me/app`), which folded
 * the case Linux needs: its Linux path with the case of the innermost `linuxRoots` entry holding
 * it. Null when it is not such a key or no root holds it.
 */
export function wslMappedDriveComparisonKeyToLinux(
  key: string,
  distro: string,
  mappedDrives: readonly WslMappedDrive[],
  linuxRoots: readonly string[]
): string | null {
  if (
    mappedDrives.length === 0 ||
    key !== key.toLowerCase() ||
    key.includes('\\') ||
    key !== normalizeRuntimePathForComparison(key)
  ) {
    return null
  }
  const folded = wslMoveSourcePathToLinux(key, distro, mappedDrives)
  if (folded === null) {
    return null
  }
  // Innermost first: a worktree's own root keeps its case, which its broader base can't restore.
  const roots = [...linuxRoots].sort((a, b) => b.length - a.length)
  for (const root of roots) {
    const lower = root.toLowerCase().replace(/\/+$/, '')
    const target = folded.toLowerCase()
    if (target === lower || target.startsWith(`${lower}/`)) {
      return `${root.replace(/\/+$/, '')}${folded.slice(lower.length)}` || '/'
    }
  }
  return null
}

/** The same drives mapped to the same shares; order and spelling of the share don't count. */
export function sameWslMappedDrives(
  left: readonly WslMappedDrive[],
  right: readonly WslMappedDrive[]
): boolean {
  const key = (drives: readonly WslMappedDrive[]): string =>
    JSON.stringify(
      drives
        .map((drive) => [
          drive.letter.toUpperCase(),
          normalizeRuntimePathForComparison(drive.share)
        ])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  return key(left) === key(right)
}
