import { joinPath } from '@/lib/path'
import {
  isPathInsideOrEqual,
  relativePathInsideRoot,
  splitPathSegments
} from '../../../../../../shared/cross-platform-path'

export function isPathEqualOrDescendant(candidatePath: string, targetPath: string): boolean {
  return isPathInsideOrEqual(targetPath, candidatePath)
}

export function getRevealAncestorDirs(worktreePath: string, filePath: string): string[] | null {
  const relativePath = relativePathInsideRoot(worktreePath, filePath)
  if (relativePath === null) {
    return null
  }

  const segments = splitPathSegments(relativePath, worktreePath)
  const ancestorDirs: string[] = []
  let currentPath = worktreePath

  for (const segment of segments.slice(0, -1)) {
    currentPath = joinPath(currentPath, segment)
    ancestorDirs.push(currentPath)
  }

  return ancestorDirs
}

/** Rows join on the root's separators, so a reveal target spelled another way must be re-spelled to match. */
export function getRevealTargetPath(rootPath: string, filePath: string): string {
  const relativePath = relativePathInsideRoot(rootPath, filePath)
  return relativePath === null ? filePath : joinPath(rootPath, relativePath)
}
