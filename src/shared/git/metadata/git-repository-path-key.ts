import { posix, win32 } from 'node:path'
import { foldWslUncPathCaseInsensitiveParts, isWslUncPath } from '../../wsl-paths'

/** Preserve POSIX bytes; comparison keys must never become filesystem paths. */
export function gitRepositoryPathKey(value: string): string {
  if (isWslUncPath(value)) {
    return foldWslUncPathCaseInsensitiveParts(win32.normalize(value)) ?? value
  }
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')
    ? win32.normalize(value).toLowerCase()
    : posix.normalize(value)
}
