import { joinPath } from '@/lib/path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import { splitPathSegments } from './path-tree'

export function normalizeAbsolutePathForComparison(path: string): string {
  return normalizeRuntimePathForComparison(path)
}

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
