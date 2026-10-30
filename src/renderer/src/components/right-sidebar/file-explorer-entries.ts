import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { splitPathSegments } from './path-tree'

export function shouldIncludeFileExplorerEntry(entry: DirEntry): boolean {
  return entry.name !== '.git' && entry.name !== 'node_modules'
}

function isDotfileSegment(segment: string): boolean {
  return segment.length > 1 && segment !== '..' && segment.startsWith('.')
}

export function isDotfileRelativePath(relativePath: string, rootPath?: string | null): boolean {
  return splitPathSegments(relativePath, rootPath).some(isDotfileSegment)
}
