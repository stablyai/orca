import type { Stats } from 'node:fs'

export function isSafeOwnedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return false
  }
  return (
    typeof process.getuid !== 'function' ||
    (stats.uid === process.getuid() && (stats.mode & 0o777) === 0o700)
  )
}
