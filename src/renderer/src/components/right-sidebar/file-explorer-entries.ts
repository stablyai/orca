import type { DirEntry } from '../../../../shared/filesystem-entry-types'

export function shouldIncludeFileExplorerEntry(entry: DirEntry): boolean {
  return entry.name !== '.git' && entry.name !== 'node_modules'
}

function isDotfileSegment(segment: string): boolean {
  return segment.length > 1 && segment !== '..' && segment.startsWith('.')
}

export function isDotfileRelativePath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some(isDotfileSegment)
}
