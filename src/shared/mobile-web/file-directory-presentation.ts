import { sha256 } from '../sha256'
import type { MobileWebFileDirectoryEntry } from './bridge-operation-contract'

export function compareMobileWebDirectoryEntries(
  left: MobileWebFileDirectoryEntry,
  right: MobileWebFileDirectoryEntry
): number {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1
  }
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function mobileWebDirectoryRevision(
  entries: MobileWebFileDirectoryEntry[],
  truncated: boolean
): string {
  const canonical = JSON.stringify({
    entries: entries.map((entry) => [entry.name, entry.isDirectory, entry.isSymlink]),
    truncated
  })
  return Array.from(sha256(new TextEncoder().encode(canonical)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
