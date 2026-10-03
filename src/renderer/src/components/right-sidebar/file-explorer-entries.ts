import type { DirEntry } from '../../../../shared/filesystem-entry-types'

// Why: `.git` is the only listing-time exclusion — `git check-ignore` never reports it,
// so no toggle could govern it downstream. Everything else (node_modules included) must
// stay loadable so the "Show Git Ignored Files" toggle actually decides its visibility.
export function shouldIncludeFileExplorerEntry(entry: DirEntry): boolean {
  return entry.name !== '.git'
}

function isDotfileSegment(segment: string): boolean {
  return segment.length > 1 && segment !== '..' && segment.startsWith('.')
}

export function isDotfileRelativePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some(isDotfileSegment)
}
