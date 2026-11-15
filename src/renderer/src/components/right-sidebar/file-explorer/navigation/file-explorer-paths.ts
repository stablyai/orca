import { joinPath } from '@/lib/path'
import {
  isPathInsideOrEqual,
  relativePathInsideRoot,
  splitPathSegments
} from '../../../../../../shared/cross-platform-path'
import { shouldIncludeFileExplorerEntry } from '../tree/file-explorer-entries'

export function isPathEqualOrDescendant(candidatePath: string, targetPath: string): boolean {
  return isPathInsideOrEqual(targetPath, candidatePath)
}

/**
 * Paths are re-spelled on the root's separators so they match rows. The explorer never lists
 * node_modules or .git, so a reveal below one stops at the folder holding it.
 */
export function getRevealTarget(
  rootPath: string,
  filePath: string
): { targetPath: string; ancestorDirs: string[] } | null {
  const relativePath = relativePathInsideRoot(rootPath, filePath)
  if (relativePath === null) {
    return null
  }
  const ancestorDirs: string[] = []
  for (const name of splitPathSegments(relativePath, rootPath).slice(0, -1)) {
    if (!shouldIncludeFileExplorerEntry({ name, isDirectory: true, isSymlink: false })) {
      // When the root holds it there is nothing to select: the root is not a row.
      const holderPath = ancestorDirs.pop()
      return holderPath === undefined ? null : { targetPath: holderPath, ancestorDirs }
    }
    ancestorDirs.push(joinPath(ancestorDirs.at(-1) ?? rootPath, name))
  }
  return { targetPath: joinPath(rootPath, relativePath), ancestorDirs }
}
