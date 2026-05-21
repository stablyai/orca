import { normalizeRelativePath } from '@/lib/path'

/**
 * Convert a folder's relative path into a "Files to include" glob.
 *
 * Why: ripgrep and git grep both treat a bare `foo/bar` glob as a path
 * literal — only `foo/bar/**` recurses into all files beneath it, which is
 * the user expectation for "Find in Folder".
 */
export function folderRelativePathToIncludeGlob(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath).replace(/\/+$/, '')
  if (!normalized) {
    return ''
  }
  return `${normalized}/**`
}
