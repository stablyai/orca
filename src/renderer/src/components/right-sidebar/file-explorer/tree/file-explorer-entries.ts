import type { DirEntry } from '../../../../../../shared/file-listing/directory-entry'
import { splitPathSegments } from '../../../../../../shared/cross-platform-path'

export function shouldIncludeFileExplorerEntry(entry: DirEntry): boolean {
  return entry.name !== '.git' && entry.name !== 'node_modules'
}

function isDotfileSegment(segment: string): boolean {
  return segment.length > 1 && segment !== '..' && segment.startsWith('.')
}

export function isDotfileRelativePath(relativePath: string, rootPath?: string | null): boolean {
  return splitPathSegments(relativePath, rootPath).some(isDotfileSegment)
}
