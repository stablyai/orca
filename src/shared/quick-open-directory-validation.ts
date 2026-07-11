import type { Stats } from 'node:fs'

export function isQuickOpenReadableDirectory(stat: Stats, allowSymlinkedRoot = false): boolean {
  // Why: an explicitly selected workspace root may be a symlink, while nested
  // traversal must never follow a symlink outside that authorized root.
  return stat.isDirectory() || Boolean(allowSymlinkedRoot && stat.isSymbolicLink())
}
